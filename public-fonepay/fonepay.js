/*!
 * fonepay.js — client for a fonepay-bridge Worker.
 *
 * Consumption paths:
 *   browser  <script src="/fonepay.js"></script>   -> window.Fonepay
 *   ESM      import { createClient } from './fonepay.mjs'
 *
 * Zero dependencies. Works from a <script> tag, a bundler, or Node 18+.
 *
 *   <script src="https://<worker>.workers.dev/fonepay.js"></script>
 *   <script>
 *     const fp = Fonepay.createClient({ baseUrl: 'https://<worker>.workers.dev' });
 *     await fp.login('merchant@example.com', 'password');
 *     const qr = await fp.collect(250, { remarks: 'Order 1042' });
 *     document.querySelector('img').src = qr.qrString;
 *     const paid = await fp.waitForPaid(qr);   // resolves when money lands
 *   </script>
 *
 * Two things differ from the NepalPay client and matter:
 *
 *  - Sign-in can stop at a one-time code or a corporate choice. Both are returned
 *    as typed outcomes instead of being flattened into an error.
 *  - Fonepay's access token is short-lived and there is no refresh endpoint, so the
 *    bridge re-signs-in using credentials held inside the sealed session. A session
 *    token here is therefore as sensitive as the password itself.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fonepay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  /** Header the bridge expects its own shared secret in, when one is configured. */
  const BRIDGE_KEY_HEADER = 'X-Bridge-Key';

  /** Route table, mirroring src/fonepay/routes.ts so helpers cannot drift. */
  const ROUTES = {
    merchants: ['GET', '/api/merchants'],
    merchantAccess: ['GET', '/api/merchants/access'],
    merchantPending: ['GET', '/api/merchants/pending-count'],
    hierarchy: ['GET', '/api/merchants/hierarchy'],
    accessList: ['POST', '/api/merchants/access-list'],
    transactions: ['POST', '/api/transactions'],
    transactionSummary: ['POST', '/api/transactions/summary'],
    transactionHierarchy: ['GET', '/api/transactions/hierarchy'],
    transactionDetail: ['GET', '/api/transactions/detail'],
    pendingTransactions: ['POST', '/api/transactions/pending'],
    settlements: ['POST', '/api/settlements'],
    staticQr: ['POST', '/api/qr/static'],
    dynamicQr: ['POST', '/api/qr/dynamic'],
    profile: ['GET', '/api/profile'],
    users: ['POST', '/api/users'],
    transactionReport: ['POST', '/api/reports/transactions'],
    collect: ['POST', '/api/collect'],
    me: ['GET', '/api/auth/me'],
    refresh: ['POST', '/api/auth/refresh'],
    logout: ['POST', '/api/auth/logout'],
  };

  const HELP = {
    AUTH_FAILED: 'Fonepay rejected the username or password.',
    OTP_REQUIRED: 'This account needs a one-time code. Call submitOtp() with the pending session.',
    CORPORATE_SELECTION_REQUIRED: 'This identifier belongs to several corporates. Pass corporateCode to login().',
    PASSWORD_CHANGE_REQUIRED: 'The account must change its password in the Fonepay portal before it can be used here.',
    SESSION_EXPIRED: 'The Fonepay session could not be renewed. Sign in again.',
    UPSTREAM_FAILED: 'Fonepay answered with an error. The bridge does not echo upstream text, so check the Worker logs.',
    UPSTREAM_UNREACHABLE: 'The Worker could not open a connection to Fonepay.',
    INVALID_REQUEST: 'The bridge rejected the request before calling upstream.',
    NO_SESSION: 'No session yet. Call login() first, or pass a session to createClient().',
    INVALID_SESSION: 'The session token is invalid or was signed with a different secret.',
    RATE_LIMITED: 'Too many sign-in attempts. Wait a minute.',
    NOT_CONFIGURED: 'The Worker is missing its SESSION_SECRET.',
    REFRESH_NOT_CONFIGURED: 'Renewal is switched off on the Worker.',
    REFRESH_FAILED: 'Fonepay rejected the stored credentials. Sign in again.',
    NETWORK_ERROR: 'The request never reached the Worker — check the base URL and CORS.',
    BRIDGE_KEY_REQUIRED: 'This bridge is closed: it needs a shared secret. Pass bridgeKey to createClient.',
    BRIDGE_KEY_INVALID: "The bridge key was rejected. It does not match the Worker's BRIDGE_KEY.",
    INVALID_COLLECT: 'That collect handle is invalid or was tampered with. Start a new collect.',
    WRONG_PROVIDER: 'That collect id belongs to the other bridge (NepalPay vs Fonepay).',
    COLLECT_EXPIRED: 'The QR expired before it was paid. Generate a new one.',
    COLLECT_TIMEOUT: 'No payment arrived in time. The watcher stopped waiting; the QR may still be valid.',
  };

  class FonepayError extends Error {
    constructor(envelope, status, path) {
      const code = envelope.code || 'UNKNOWN';
      super(envelope.message || HELP[code] || 'Request failed (' + status + ')');
      this.name = 'FonepayError';
      this.code = code;
      this.status = status;
      this.path = path;
      this.help = HELP[code] || '';
      this.body = envelope;
      this.retryable = status >= 500 || code === 'NETWORK_ERROR' || code === 'UPSTREAM_UNREACHABLE';
    }
  }

  const isEnvelope = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && 'code' in value && 'status' in value;

  /**
   * Unwrap the bridge's envelope, and one nested one if upstream doubled it.
   *
   * Fonepay's own body is passed through untouched on success, so this must not
   * mistake upstream's `code: "0"` envelope for the bridge's `code: "000"` one —
   * hence the `status` check.
   */
  function unwrap(json) {
    if (!isEnvelope(json)) return json && 'data' in json ? json.data : json;
    if (isEnvelope(json.data)) return json.data.data;
    return json.data;
  }

  function createClient(options) {
    options = options || {};
    const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('createClient needs a baseUrl, e.g. https://bridge.example.workers.dev');

    const doFetch = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) throw new Error('No fetch available. Pass one in options.fetch (Node 18+ has a global fetch).');

    const timeoutMs = options.timeout === undefined ? 25000 : options.timeout;
    const bridgeKey = options.bridgeKey ? String(options.bridgeKey) : '';
    const log = options.debug ? (typeof console !== 'undefined' ? console : { log() {} }) : null;

    const client = {
      baseUrl,
      version: VERSION,
      session: options.session || null,
      lastEnvelope: null,
      onRenew: options.onRenew || null,
      onError: options.onError || null,
      user: null,
      /** Set when sign-in stopped at the OTP step. */
      pendingSession: null,
      /** Set when sign-in stopped at a corporate choice. */
      corporateOptions: null,
    };

    async function request(path, requestOptions) {
      requestOptions = requestOptions || {};
      const method = requestOptions.method || 'POST';
      const body = requestOptions.body;
      const allowFailure = Boolean(requestOptions.allowFailure);

      const headers = {};
      if (client.session) headers.Authorization = 'Bearer ' + client.session;
      if (bridgeKey) headers[BRIDGE_KEY_HEADER] = bridgeKey;
      if (body !== undefined && method !== 'GET') headers['Content-Type'] = 'application/json';

      const controller = timeoutMs && typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      let response, text;
      try {
        response = await doFetch(baseUrl + path, {
          method,
          headers,
          body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        });
        text = await response.text();
      } catch (error) {
        if (timer) clearTimeout(timer);
        const envelope = {
          code: 'NETWORK_ERROR',
          status: 'FAILED',
          message: String((error && error.message) || error),
          data: null,
        };
        const failure = new FonepayError(envelope, 0, path);
        if (client.onError) client.onError(failure);
        if (allowFailure) return { ok: false, status: 0, envelope, error: failure };
        throw failure;
      }
      if (timer) clearTimeout(timer);

      const rotated =
        response.headers && response.headers.get && response.headers.get('X-Session-Token');
      if (rotated) {
        client.session = rotated;
        if (log) log.log('[fonepay] session renewed');
        if (client.onRenew) client.onRenew(rotated);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        json = {
          code: 'NON_JSON',
          status: 'FAILED',
          message: 'Bridge returned non-JSON: ' + text.slice(0, 160),
          data: null,
        };
      }

      client.lastEnvelope = json;
      const ok = response.ok && json.status === 'SUCCESS';

      if (!ok && !allowFailure) {
        const failure = new FonepayError(json, response.status, path);
        if (client.onError) client.onError(failure);
        throw failure;
      }

      return { ok, status: response.status, envelope: json, headers: response.headers, httpStatus: response.status };
    }

    /**
     * Call a route.
     *
     * `query` is how a GET route receives its parameters: paths like
     * `/merchants/hierarchy/{merchantId}` cannot carry a body, so the bridge reads
     * the query string for them.
     */
    async function call(nameOrPath, body, method, query) {
      const route = ROUTES[nameOrPath];
      let path = route ? route[1] : nameOrPath;
      if (query) {
        const pairs = Object.keys(query)
          .filter((key) => query[key] !== undefined && query[key] !== null && query[key] !== '')
          .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
        if (pairs.length) path += '?' + pairs.join('&');
      }
      const verb = method || (route ? route[0] : body === undefined ? 'GET' : 'POST');
      const result = await request(path, {
        method: verb,
        body: verb === 'GET' ? undefined : body || {},
      });
      return unwrap(result.envelope);
    }

    /* ---------------- session ---------------- */

    /**
     * Sign in.
     *
     * Resolves either a session or a *typed* stop:
     *   { otpRequired: true, pendingSession, otpType }        finish with submitOtp()
     *   { corporateSelectionRequired: true, corporateOptions } retry with corporateCode
     */
    client.login = async function (emailOrUsername, password, loginOptions) {
      loginOptions = loginOptions || {};
      const result = await request('/api/auth/login', {
        method: 'POST',
        body: {
          emailOrUsername: emailOrUsername,
          password: password,
          ...(loginOptions.corporateCode ? { corporateCode: loginOptions.corporateCode } : {}),
        },
        allowFailure: true,
      });

      const envelope = result.envelope;
      const data = envelope.data || {};

      if (result.ok) {
        client.session = data.session;
        client.user = data.user;
        client.pendingSession = null;
        client.corporateOptions = null;
        return {
          session: data.session,
          user: data.user,
          expiresAt: data.expiresAt,
          autoRenew: data.autoRenew,
        };
      }

      if (envelope.code === 'OTP_REQUIRED' && data.pendingSession) {
        client.pendingSession = data.pendingSession;
        client.user = null;
        return {
          otpRequired: true,
          pendingSession: data.pendingSession,
          otpType: data.otpType || 'OTP',
          hint: data.hint || HELP.OTP_REQUIRED,
        };
      }

      if (envelope.code === 'CORPORATE_SELECTION_REQUIRED') {
        client.corporateOptions = data.corporateOptions || [];
        return { corporateSelectionRequired: true, corporateOptions: client.corporateOptions };
      }

      throw new FonepayError(envelope, result.httpStatus || result.status, '/api/auth/login');
    };

    /**
     * Adopt a token minted by a real browser (POST /api/auth/import).
     *
     * Fonepay's edge classifies the TLS client at sign-in and only issues usable
     * tokens to real browsers, so a server-side login can come back
     * `MINT_REJECTED`. Sign in at the fonepay portal yourself, read
     * `sessionStorage.AccessToken` (and optionally `expireTime`), and hand them
     * over here. Data calls accept the token from any client. Imported sessions
     * never auto-renew — import again before the token expires.
     */
    client.importToken = async function (accessToken, importOptions) {
      importOptions = importOptions || {};
      const body = { accessToken: accessToken };
      if (importOptions.expireTime !== undefined && importOptions.expireTime !== null) {
        body.expireTime = importOptions.expireTime;
      }
      if (importOptions.expiresAt !== undefined && importOptions.expiresAt !== null) {
        body.expiresAt = importOptions.expiresAt;
      }
      const data = await call('/api/auth/import', body);
      client.session = data.session;
      client.user = data.user;
      client.pendingSession = null;
      return {
        session: data.session,
        user: data.user,
        expiresAt: data.expiresAt,
        autoRenew: data.autoRenew,
        verified: data.verified,
      };
    };

    /** Finish a sign-in that stopped at the one-time-code step. */
    client.submitOtp = async function (code, pendingSession) {
      const pending = pendingSession || client.pendingSession;
      if (!pending) throw new Error('submitOtp needs the pending session returned by login()');
      if (!code) throw new Error('submitOtp needs the one-time code');

      const data = await call('otp', { session: pending, otpCode: String(code) });
      client.session = data.session;
      client.user = data.user;
      client.pendingSession = null;
      return { session: data.session, user: data.user, expiresAt: data.expiresAt };
    };

    /** Resolve the corporates behind an identifier, without a password. */
    client.lookup = (emailOrUsername) => call('/api/auth/lookup', { emailOrUsername });

    client.me = async function () {
      const data = await call('me');
      client.user = data;
      return data;
    };

    client.refresh = async function () {
      const data = await call('refresh');
      client.session = data.session;
      return data;
    };

    client.logout = async function () {
      try {
        await call('logout');
      } finally {
        client.session = null;
        client.user = null;
        client.pendingSession = null;
      }
    };

    client.setSession = function (session) {
      client.session = session || null;
      return client;
    };

    client.isAuthenticated = () => Boolean(client.session);

    /* ---------------- merchants ---------------- */

    client.merchants = () => call('merchants');
    client.merchantAccess = () => call('merchantAccess');
    client.pendingAccessCount = () => call('merchantPending');
    client.hierarchy = (merchantId) => call('hierarchy', undefined, 'GET', { merchantId: merchantId });
    client.merchantAccessList = (merchantId, paging) =>
      call('accessList', Object.assign({ merchantId: merchantId || '' }, page(paging)));

    /* ---------------- transactions & settlements ---------------- */

    client.transactions = (filters) =>
      call('transactions', {
        page: 0,
        size: (filters && filters.size) || 25,
        fromTransmissionDateTime: (filters && filters.from) || day(0),
        toTransmissionDateTime: (filters && filters.to) || day(0),
        merchantId: (filters && filters.merchantId) || '',
        subMerchantId: (filters && filters.subMerchantId) || '',
        terminalId: (filters && filters.terminalId) || '',
      });

    client.transactionSummary = (filters) =>
      call('transactionSummary', {
        fromTransmissionDateTime: (filters && filters.from) || day(0),
        toTransmissionDateTime: (filters && filters.to) || day(0),
        merchantId: (filters && filters.merchantId) || '',
      });

    client.transactionHierarchy = () => call('transactionHierarchy');
    client.transactionDetail = (transactionId) =>
      call('transactionDetail', undefined, 'GET', { transactionId: transactionId });
    client.pendingTransactions = (paging) => call('pendingTransactions', page(paging));

    client.settlements = (filters) =>
      call('settlements', {
        pageNumber: (filters && filters.page) || 1,
        pageSize: (filters && filters.size) || 25,
        fromSettlementDate: (filters && filters.from) || day(0),
        toSettlementDate: (filters && filters.to) || day(0),
        merchantId: (filters && filters.merchantId) || '',
      });

    /* ---------------- QR ---------------- */

    client.staticQr = (merchantId, terminal) =>
      call('staticQr', {
        merchantId: merchantId || '',
        subMerchantId: '',
        terminalId: terminal || '',
      });

    client.dynamicQr = (input) => {
      input = input || {};
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('dynamicQr needs amount > 0');
      return call('dynamicQr', {
        amount: amount,
        remarks: input.remarks || '',
        orderId: input.orderId || '',
        merchantId: input.merchantId || '',
        subMerchantId: input.subMerchantId || '',
        terminalId: input.terminalId || '',
      });
    };

    /* ---------------- collect: take a payment ---------------- */

    /**
     * Mint a dynamic QR that the bridge can *recognise* later.
     *
     * A remark is always attached (generated when you do not supply one), because
     * the collection report has no order-id column — the remark is what makes this
     * particular payment findable.
     */
    client.collect = async function (amount, collectOptions) {
      collectOptions = collectOptions || {};
      const value = Number(amount && typeof amount === 'object' ? amount.amount : amount);
      if (!Number.isFinite(value) || value <= 0) throw new Error('collect needs an amount greater than zero');

      const data = await call('collect', {
        amount: value,
        remarks: collectOptions.remarks || '',
        orderId: collectOptions.orderId || '',
        merchantId: collectOptions.merchantId || '',
        subMerchantId: collectOptions.subMerchantId || '',
        terminalId: collectOptions.terminalId || '',
        expiresInSeconds: collectOptions.expiresInSeconds,
      });

      return {
        collectId: data.collectId,
        /** The QRCPS payload, renderable with any QR encoder. */
        qrString: data.qrString,
        amount: data.amount,
        remarks: data.remarks,
        orderId: data.orderId,
        expiresAt: data.expiresAt,
        statusPath: data.statusPath,
        retryAfterMs: data.retryAfterMs || 2500,
        keys: data.keys || {},
        realtime: data.realtime || null,
      };
    };

    client.collectStatus = async function (handle) {
      const path =
        typeof handle === 'string'
          ? handle
          : handle && (handle.statusPath || (handle.collectId ? '/api/collect/' + handle.collectId : ''));
      if (!path) throw new Error('collectStatus needs a handle from collect()');
      const result = await request(path, { method: 'GET' });
      return result.envelope.data;
    };

    client.waitForPaid = async function (handle, waitOptions) {
      waitOptions = waitOptions || {};
      const timeoutMs = waitOptions.timeoutMs === undefined ? 300000 : waitOptions.timeoutMs;
      const cap = waitOptions.maxIntervalMs || 5000;
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const status = await client.collectStatus(handle);
        if (waitOptions.onStatus) waitOptions.onStatus(status);

        if (status.state === 'PAID') return status;
        if (status.state === 'EXPIRED') {
          if (waitOptions.resolveOnExpiry) return status;
          throw new FonepayError(
            { code: 'COLLECT_EXPIRED', message: HELP.COLLECT_EXPIRED },
            410,
            handle && handle.statusPath,
          );
        }

        if (Date.now() >= deadline) {
          if (waitOptions.resolveOnTimeout) return status;
          throw new FonepayError(
            { code: 'COLLECT_TIMEOUT', message: HELP.COLLECT_TIMEOUT, data: status },
            408,
            handle && handle.statusPath,
          );
        }

        const suggested =
          waitOptions.intervalMs || status.retryAfterMs || (handle && handle.retryAfterMs) || 2500;
        await sleep(Math.min(cap, Math.max(500, suggested)), waitOptions.signal);
      }
    };

    /* ---------------- profile & reports ---------------- */

    client.profile = () => call('profile');
    client.users = () => call('users');
    client.transactionReport = (paging) => call('transactionReport', page(paging));

    /** Escape hatch: any bridge route, returning the full envelope. */
    client.raw = async function (nameOrPath, body, method) {
      const route = ROUTES[nameOrPath];
      const path = route ? route[1] : nameOrPath;
      const verb = method || (route ? route[0] : body === undefined ? 'GET' : 'POST');
      return request(path, { method: verb, body: verb === 'GET' ? undefined : body || {} });
    };

    /** Never throws — useful for health checks and polling. */
    client.try = (path, body, method) =>
      request(path, { method: method || 'POST', body: body, allowFailure: true });

    return client;
  }

  /* ---------------- helpers ---------------- */

  function page(paging) {
    return {
      pageNumber: (paging && paging.page) || 1,
      pageSize: (paging && paging.size) || 10,
    };
  }

  /** ISO day, offset by whole days — Fonepay's report filters are plain dates. */
  function day(offset) {
    return new Date(Date.now() + (offset || 0) * 864e5).toISOString().slice(0, 10);
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('aborted'));
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Embed the hosted collect page in any site.
   *
   * The session and bridge key travel to the iframe over postMessage, so they never
   * appear in the URL, browser history or a referrer.
   */
  function payWidget(target, options) {
    options = options || {};
    const node = typeof target === 'string' ? document.querySelector(target) : target;
    if (!node) throw new Error('payWidget needs a mount element');
    if (!options.baseUrl) throw new Error('payWidget needs baseUrl (the Worker origin)');

    const query = new URLSearchParams({
      amount: String(options.amount || 0),
      remarks: options.remarks || '',
      theme: options.theme || 'dark',
      origin: location.origin,
    });

    const frame = document.createElement('iframe');
    frame.src = options.baseUrl.replace(/\/+$/, '') + '/pay?' + query.toString();
    frame.title = options.title || 'Fonepay QR payment';
    frame.setAttribute('loading', 'lazy');
    frame.style.width = options.width || '100%';
    frame.style.height = options.height || '420px';
    frame.style.border = '0';
    frame.style.borderRadius = options.radius || '16px';
    frame.style.display = 'block';
    node.innerHTML = '';
    node.appendChild(frame);

    const postConfig = () =>
      frame.contentWindow.postMessage(
        {
          source: 'fonepay-host',
          type: 'config',
          session: options.session || null,
          bridgeKey: options.bridgeKey || null,
        },
        '*',
      );

    function onMessage(event) {
      const data = event.data;
      if (!data || data.source !== 'fonepay-pay' || event.source !== frame.contentWindow) return;

      if (data.type === 'ready') postConfig();
      if (data.type === 'renewed' && typeof options.onRenew === 'function') options.onRenew(data.session);
      if (data.type === 'paid' && typeof options.onPaid === 'function') options.onPaid(data);
      if (data.type === 'error' && typeof options.onError === 'function') options.onError(data);
      if (typeof options.onStatus === 'function') options.onStatus(data);
    }

    window.addEventListener('message', onMessage);

    return {
      frame,
      setSession(session) {
        options.session = session;
        postConfig();
      },
      destroy() {
        window.removeEventListener('message', onMessage);
        frame.remove();
      },
    };
  }

  return {
    version: VERSION,
    createClient,
    payWidget,
    FonepayError,
    ROUTES,
    HELP,
    BRIDGE_KEY_HEADER,
  };
});
