/*!
 * nepalpay.js — client for a nepalpay-bridge Worker.
 *
 * Consumption paths:
 *   browser  <script src="/nepalpay.js"></script>   -> window.NepalPay
 *   ESM      import { createClient } from './nepalpay.mjs'
 *   CJS      not supported directly (this repo is type: module) — use nepalpay.mjs
 *
 * Zero dependencies. Works from a <script> tag, from a bundler, and from Node 18+.
 * It never sees a NepalPay username twice: the bridge signs in upstream and hands
 * back an opaque session token, which this client stores and slides forward
 * automatically whenever the bridge renews it.
 *
 *   <script src="https://<your-worker>.workers.dev/nepalpay.js"></script>
 *   <script>
 *     const np = NepalPay.createClient({ baseUrl: 'https://<your-worker>.workers.dev' });
 *     await np.login('username', 'password');
 *     const { data } = await np.balance();
 *   </script>
 *
 * Adding `?session=` to the URL is never needed — the session rides in a header
 * from the bridge and may contain a NepalPay access token, so treat it like one.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NepalPay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.1.0';

  /** Header the bridge expects its own shared secret in, when one is configured. */
  const BRIDGE_KEY_HEADER = 'X-Bridge-Key';

  /** Route table, mirroring src/routes.ts so helpers cannot drift. */
  const ROUTES = {
    balance: ['POST', '/api/dashboard/balance'],
    recentTransactions: ['POST', '/api/dashboard/transactions'],
    settlementStatistic: ['POST', '/api/dashboard/settlement'],
    dashboardImages: ['GET', '/api/dashboard/images'],
    stores: ['POST', '/api/stores'],
    searchStores: ['POST', '/api/stores/search'],
    storeSummary: ['POST', '/api/stores/summary'],
    terminals: ['POST', '/api/stores/terminals'],
    dynamicQr: ['POST', '/api/qr'],
    storeQr: ['POST', '/api/qr/store'],
    terminalQr: ['POST', '/api/qr/terminal'],
    transactionReport: ['POST', '/api/reports/transactions'],
    summaryReport: ['POST', '/api/reports/summary'],
    networkReport: ['POST', '/api/reports/network'],
    refundReport: ['POST', '/api/reports/refunds'],
    settlementReport: ['POST', '/api/reports/settlements'],
    refundableTransactions: ['POST', '/api/refunds'],
    refundReasons: ['GET', '/api/refunds/reasons'],
    users: ['POST', '/api/users'],
    roles: ['GET', '/api/users/roles'],
    banks: ['POST', '/api/banks'],
    collect: ['POST', '/api/collect'],
    me: ['GET', '/api/auth/me'],
    refresh: ['POST', '/api/auth/refresh'],
    logout: ['POST', '/api/auth/logout'],
  };

  /**
   * What each bridge error actually means. A transport or config problem must
   * never be presented as "your password is wrong".
   */
  const HELP = {
    AUTH_FAILED: 'NepalPay rejected the username or password.',
    UPSTREAM_BLOCKED:
      'The NepalPay edge refused the request before the API saw it, so the credentials were never evaluated. Usually a header-fingerprint policy — check NEPALPAY_HEADER_MODE on the Worker.',
    UPSTREAM_UNREACHABLE: 'The Worker could not open a connection to NepalPay.',
    INVALID_REQUEST: 'The bridge rejected the request body before calling upstream.',
    NO_SESSION: 'No session yet. Call login() first, or pass a session to createClient().',
    INVALID_SESSION: 'The session token is invalid or was signed with a different secret.',
    SESSION_EXPIRED: 'The upstream token expired and could not be renewed. Sign in again.',
    RATE_LIMITED: 'Too many sign-in attempts from this address. Wait a minute.',
    NOT_CONFIGURED: 'The Worker is missing its SESSION_SECRET.',
    REFRESH_NOT_CONFIGURED: 'Renewal is switched off on the Worker.',
    REFRESH_FAILED: 'The refresh token was rejected. Sign in again.',
    NETWORK_ERROR: 'The request never reached the Worker — check the base URL and CORS.',
    BRIDGE_KEY_REQUIRED:
      'This bridge is closed: it needs a shared secret. Pass bridgeKey to createClient (or leave BRIDGE_KEY unset on the Worker while wiring a site up).',
    BRIDGE_KEY_INVALID: 'The bridge key was rejected. It does not match the Worker\'s BRIDGE_KEY.',
    INVALID_COLLECT: 'That collect handle is invalid or was tampered with. Start a new collect.',
    WRONG_PROVIDER: 'That collect id belongs to the other bridge (NepalPay vs Fonepay).',
    COLLECT_EXPIRED: 'The QR expired before it was paid. Generate a new one.',
    COLLECT_TIMEOUT: 'No payment arrived in time. The QR may still be valid — the watcher just stopped waiting.',
  };

  class NepalPayError extends Error {
    constructor(envelope, status, path) {
      const code = envelope.code || 'UNKNOWN';
      super(envelope.message || HELP[code] || 'Request failed (' + status + ')');
      this.name = 'NepalPayError';
      this.code = code;
      this.status = status;
      this.path = path;
      this.help = HELP[code] || '';
      this.body = envelope;
      /** True when retrying the same call may succeed (upstream hiccups). */
      this.retryable = status >= 500 || code === 'NETWORK_ERROR' || code === 'UPSTREAM_UNREACHABLE';
    }
  }

  const isEnvelope = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && 'code' in value && 'status' in value;

  /** Unwrap the bridge's envelope, and one nested envelope if upstream doubled it. */
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

    const timeoutMs = options.timeout === undefined ? 20000 : options.timeout;
    const bridgeKey = options.bridgeKey ? String(options.bridgeKey) : '';

    const client = {
      baseUrl,
      version: VERSION,
      session: options.session || null,
      lastEnvelope: null,
      onRenew: options.onRenew || null,
      onError: options.onError || null,
      /** Cosmetic only — surfaced in the dashboard header. */
      user: null,
    };

    const log = options.debug ? (typeof console !== 'undefined' ? console : { log() {} }) : null;

    /**
     * One call to the bridge. Non-2xx responses throw, because every caller here
     * expects data and a thrown NepalPayError carries code/help/retryable.
     */
    async function request(path, { method = 'POST', body, allowFailure = false } = {}) {
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
        const envelope = { code: 'NETWORK_ERROR', status: 'FAILED', message: String((error && error.message) || error), data: null };
        const failure = new NepalPayError(envelope, 0, path);
        if (client.onError) client.onError(failure);
        if (allowFailure) return { ok: false, status: 0, envelope, error: failure };
        throw failure;
      }
      if (timer) clearTimeout(timer);

      // Sliding renewal: the bridge hands back a fresh sealed session here.
      const rotated = response.headers && response.headers.get && response.headers.get('X-Session-Token');
      if (rotated) {
        client.session = rotated;
        if (log) log.log('[nepalpay] session renewed');
        if (client.onRenew) client.onRenew(rotated);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        json = { code: 'NON_JSON', status: 'FAILED', message: 'Bridge returned non-JSON: ' + text.slice(0, 160), data: null };
      }

      client.lastEnvelope = json;
      const ok = response.ok && json.status === 'SUCCESS';

      if (!ok && !allowFailure) {
        const failure = new NepalPayError(json, response.status, path);
        if (client.onError) client.onError(failure);
        throw failure;
      }

      return { ok, status: response.status, envelope: json, headers: response.headers };
    }

    /** Call a route and return its unwrapped `data`. */
    async function call(nameOrPath, body, method) {
      const route = ROUTES[nameOrPath];
      const path = route ? route[1] : nameOrPath;
      const verb = method || (route ? route[0] : body === undefined ? 'GET' : 'POST');
      const result = await request(path, { method: verb, body: verb === 'GET' ? undefined : body || {} });
      return unwrap(result.envelope);
    }

    /* ---------------- session ---------------- */

    client.login = async function (username, password) {
      const result = await request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      const data = result.envelope.data;
      client.session = data.session;
      client.user = data.user;
      return { session: data.session, user: data.user, expiresAt: data.expiresAt, autoRenew: data.autoRenew };
    };

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
      }
    };

    client.setSession = function (session) {
      client.session = session || null;
      return client;
    };

    client.isAuthenticated = () => Boolean(client.session);

    client.secondsUntilExpiry = function () {
      if (!client.user || !client.user.expiresAt) return null;
      return Math.max(0, Math.round((client.user.expiresAt - Date.now()) / 1000));
    };

    /* ---------------- dashboard ---------------- */

    client.balance = async function () {
      const data = await call('balance', {});
      const info = (data && data.settleUnsettleTxnInfo) || {};
      return {
        settled: info.totalSettleAmount || 0,
        settledCount: info.totalSettleTxnCount || 0,
        unsettled: info.totalUnsettleAmount || 0,
        unsettledCount: info.totalUnsettleTxnCount || 0,
        total: Number(info.totalSettleAmount || 0) + Number(info.totalUnsettleAmount || 0),
        session: (data && data.sessionSrlInfo) || null,
        raw: data,
      };
    };

    client.recentTransactions = () => call('recentTransactions', {});
    client.settlementStatistic = () => call('settlementStatistic', {});
    client.dashboardImages = () => call('dashboardImages');

    /* ---------------- stores & terminals ---------------- */

    client.stores = (options) => call('stores', { pageable: pageable(options) });
    client.searchStores = (storeLabel, options) =>
      call('searchStores', { storeLabel: storeLabel || '', pageable: pageable(options) });
    client.storeSummary = (storeLabel, terminal) =>
      call('storeSummary', { storeLabel: storeLabel || '', terminal: terminal || '' });
    client.terminals = (storeLabel, terminal) =>
      call('terminals', { storeLabel: storeLabel || '', terminal: terminal || '' });

    /* ---------------- QR ---------------- */

    /** Dynamic QR for an amount. Returns { qrString, webSocketUrl, validationTraceId, ... }. */
    client.createQr = async function (input) {
      const amount = Number(input && input.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('createQr needs amount > 0');
      if (amount > 2000000) throw new Error('createQr amount is capped at 2,000,000 by NepalPay');
      return call('dynamicQr', {
        storeLabel: input.storeLabel || '',
        terminal: input.terminal || '',
        amount,
        remarks: input.remarks || '',
      });
    };

    client.storeQr = (storeLabel) => call('storeQr', { storeLabel: storeLabel || '' });
    client.terminalQr = (storeLabel, terminal) =>
      call('terminalQr', { storeLabel: storeLabel || '', terminal: terminal || '' });

    /* ---------------- collect: take a payment ---------------- */

    /**
     * Mint a dynamic QR and return a handle to watch it with.
     *
     *   const qr = await np.collect(250, { remarks: 'Order 1042' });
     *   showQr(qr.qrString);
     *   const paid = await np.waitForPaid(qr);   // resolves when it is paid
     */
    client.collect = async function (amount, collectOptions) {
      collectOptions = collectOptions || {};
      const value = Number(amount && typeof amount === 'object' ? amount.amount : amount);
      if (!Number.isFinite(value) || value <= 0) throw new Error('collect needs an amount greater than zero');

      const data = await call('collect', {
        amount: value,
        storeLabel: collectOptions.storeLabel || collectOptions.store || '',
        terminal: collectOptions.terminal || '',
        remarks: collectOptions.remarks || '',
        orderId: collectOptions.orderId || '',
        expiresInSeconds: collectOptions.expiresInSeconds,
      });

      return {
        collectId: data.collectId,
        /** A `data:image/png;base64,…` QR, ready for an <img src>. */
        qrString: data.qrString,
        amount: data.amount,
        remarks: data.remarks,
        orderId: data.orderId,
        expiresAt: data.expiresAt,
        /** Sealed; POST it back exactly as-is via collectStatus/waitForPaid. */
        statusPath: data.statusPath,
        retryAfterMs: data.retryAfterMs || 2500,
        keys: data.keys || {},
        /** Live-notification material, if the caller wants to watch it directly. */
        realtime: data.realtime || null,
      };
    };

    /** One status check. Resolves `{ state: 'PENDING' | 'PAID' | 'EXPIRED', ... }`. */
    client.collectStatus = async function (handle) {
      const path =
        typeof handle === 'string'
          ? handle
          : handle && (handle.statusPath || (handle.collectId ? '/api/collect/' + handle.collectId : ''));
      if (!path) throw new Error('collectStatus needs a handle from collect()');
      const result = await request(path, { method: 'GET' });
      return result.envelope.data;
    };

    /**
     * Poll a collect until it is paid.
     *
     * Resolves with the status (including the matched transaction). Rejects with
     * COLLECT_EXPIRED if the QR lapsed, COLLECT_TIMEOUT if we stopped waiting, or
     * an abort if `signal` fires. The bridge throttles its own repeat scans, so
     * several watchers of one QR do not multiply the upstream load.
     */
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
          throw new NepalPayError(
            { code: 'COLLECT_EXPIRED', message: HELP.COLLECT_EXPIRED },
            410,
            handle && handle.statusPath,
          );
        }

        const now = Date.now();
        if (now >= deadline) {
          if (waitOptions.resolveOnTimeout) return status;
          throw new NepalPayError(
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

    /* ---------------- reports ---------------- */

    client.reports = {
      transactions: (filters) =>
        call('transactionReport', reportBody(filters, ['storeLabel', 'terminal', 'nqrTxnId', 'payerMobileNumber', 'issuerNetwork'])),
      summary: (filters) => call('summaryReport', reportBody(filters, ['storeLabel', 'terminal', 'issuerNetwork'])),
      refunds: (filters) => call('refundReport', reportBody(filters, ['txnStatus', 'payerMobileNumber'])),
      settlements: (filters) => call('settlementReport', reportBody(filters, ['issuerNetwork'])),
      network: () => call('networkReport', {}),
    };

    client.refunds = {
      list: (filters) =>
        call('refundableTransactions', Object.assign({}, dateRange(filters), {
          nqrTxnId: (filters && filters.nqrTxnId) || '',
          payerMobileNumber: (filters && filters.payerMobileNumber) || '',
          pageable: pageable(filters),
        })),
      reasons: () => call('refundReasons'),
    };

    client.users = {
      list: (filters) => call('users', {
        username: (filters && filters.username) || '',
        mobileNumber: (filters && filters.mobileNumber) || '',
        pageable: pageable(filters),
      }),
      roles: () => call('roles'),
    };

    client.banks = () => call('banks', {});

    /** Escape hatch: any bridge route, returning the full envelope. */
    client.raw = async function (nameOrPath, body, method) {
      const route = ROUTES[nameOrPath];
      const path = route ? route[1] : nameOrPath;
      const verb = method || (route ? route[0] : body === undefined ? 'GET' : 'POST');
      return request(path, { method: verb, body: verb === 'GET' ? undefined : body || {} });
    };

    /** Never throws — useful for health checks and polling. */
    client.try = (path, body, method) => request(path, { method: method || 'POST', body, allowFailure: true });

    return client;
  }

  /* ---------------- small helpers ---------------- */

  function pageable(options) {
    return {
      currentPage: (options && options.page) || 1,
      rowPerPage: (options && options.size) || 10,
      ...(options && options.paginated === false ? {} : { paginated: true, enable: true }),
    };
  }

  /** Local calendar date. NepalPay's own dates are Nepal time, not UTC. */
  function isoDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function dateRange(filters) {
    const today = isoDate(new Date());
    const weekAgo = isoDate(new Date(Date.now() - 7 * 864e5));
    const from = (filters && filters.from) || weekAgo;
    const to = (filters && filters.to) || today;
    if (new Date(to) - new Date(from) > 90 * 864e5) {
      throw new Error('NepalPay reports accept at most a 90-day range; page through windows instead');
    }
    return { fromDate: from, toDate: to };
  }

  /**
   * Every report takes the same date range and pager; the extra filters differ per
   * report, so each caller declares the keys it wants. Sending only those keeps the
   * upstream body identical to what the portal itself sends.
   */
  function reportBody(filters, keys) {
    const body = Object.assign({}, dateRange(filters), { pageable: pageable(filters) });
    for (const key of keys || []) body[key] = (filters && filters[key]) || '';
    return body;
  }

  /**
   * Embed the hosted QR page in any site.
   *
   * The session is handed to the iframe over postMessage rather than a URL, so it
   * never lands in browser history, referrers, or a server access log.
   */
  function payWidget(target, options) {
    options = options || {};
    const node = typeof target === 'string' ? document.querySelector(target) : target;
    if (!node) throw new Error('payWidget needs a mount element');
    if (!options.baseUrl) throw new Error('payWidget needs baseUrl (the Worker origin)');

    const query = new URLSearchParams({
      amount: String(options.amount || 0),
      store: options.storeLabel || '',
      terminal: options.terminal || '',
      remarks: options.remarks || '',
      theme: options.theme || 'dark',
      origin: location.origin,
    });

    // The session and the bridge key are handed to the frame over postMessage
    // rather than the URL, so neither lands in history, a referrer or a log.
    const postConfig = () =>
      frame.contentWindow.postMessage(
        {
          source: 'nepalpay-host',
          type: 'config',
          session: options.session || null,
          bridgeKey: options.bridgeKey || null,
        },
        '*',
      );

    // `/pay` is the canonical URL; Cloudflare's asset handling redirects
    // `/pay.html` to it, which would cost a round trip on every embed.
    const frame = document.createElement('iframe');
    frame.src = options.baseUrl.replace(/\/+$/, '') + '/pay?' + query.toString();
    frame.title = options.title || 'NepalPay QR payment';
    frame.setAttribute('loading', 'lazy');
    frame.style.width = options.width || '100%';
    frame.style.height = options.height || '420px';
    frame.style.border = '0';
    frame.style.borderRadius = options.radius || '16px';
    frame.style.display = 'block';
    node.innerHTML = '';
    node.appendChild(frame);

    function onMessage(event) {
      const data = event.data;
      if (!data || data.source !== 'nepalpay-pay' || event.source !== frame.contentWindow) return;

      if (data.type === 'ready') postConfig();
      if (data.type === 'renewed' && typeof options.onRenew === 'function') options.onRenew(data.session);
      if (data.type === 'paid' && typeof options.onPaid === 'function') options.onPaid(data);
      if (data.type === 'error' && typeof options.onError === 'function') options.onError(data);
      if (typeof options.onStatus === 'function') options.onStatus(data);
    }

    window.addEventListener('message', onMessage);

    return {
      frame,
      /** Hand a (possibly renewed) session to the widget. */
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

  /** Wait for `ms`, rejecting early when an AbortSignal fires. */
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

  return {
    version: VERSION,
    createClient,
    payWidget,
    NepalPayError,
    ROUTES,
    HELP,
    BRIDGE_KEY_HEADER,
  };
});
