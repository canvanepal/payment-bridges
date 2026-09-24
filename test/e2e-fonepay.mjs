#!/usr/bin/env node
/**
 * End-to-end test for the Fonepay bridge.
 *
 * Runs the real Worker module against a local mock of the corporate gateway, so
 * sign-in, the two-step corporate lookup, the OTP hand-off, identity scoping,
 * expiry and the renew-by-re-signin path are all exercised without touching
 * production.
 *
 *   npm run test:e2e:fonepay
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const results = [];
function check(name, ok, extra = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

/* ------------------------------------------------------------------ */
/* Mock gateway                                                        */
/* ------------------------------------------------------------------ */

const state = {
  counter: 0,
  currentToken: null,
  calls: [],
  /** When set, the collection report contains a payment carrying these remarks. */
  paidRemarks: '',
  paidAmount: 0,
};

const issueToken = (label) => {
  state.counter += 1;
  const token = `tok-${state.counter}-${label}`;
  state.currentToken = token;
  return token;
};

/** How long the mock says the token lives, steered by the username. */
const ttlFor = (username) => {
  // An epoch timestamp already in the past: the token lapsed while this process
  // was not looking. (A sub-30-second *duration* is rejected as implausible by
  // the client's parser, which is exactly the ambiguity that fallback guards.)
  if (/short|expired/.test(username)) return Date.now() - 60_000;
  if (/due/.test(username)) return 30;
  return 3600;
};

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;

  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* leave empty */
  }

  const path = (req.url ?? '').split('?')[0];
  const query = (req.url ?? '').includes('?') ? (req.url ?? '').split('?')[1] : '';
  const auth = req.headers.authorization ?? '';

  state.calls.push({
    path,
    query,
    auth,
    body,
    origin: req.headers.origin ?? '',
    referer: req.headers.referer ?? '',
    ua: req.headers['user-agent'] ?? '',
  });

  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const envelope = (data, message) => ({ message, code: '0', isSuccess: true, data });
  const requireToken = () => {
    if (!auth.startsWith('Bearer ')) {
      send(401, { message: 'Unauthorized', success: false });
      return false;
    }
    if (auth.slice(7) !== state.currentToken) {
      send(401, { message: 'Token expired', success: false });
      return false;
    }
    return true;
  };

  /* --- auth -------------------------------------------------------- */

  if (path.endsWith('/authentication/email-lookup')) {
    const username = String(body.emailOrUsername ?? '');
    if (/unknown/.test(username)) {
      return send(200, { emailExists: false, requiresCorporateSelection: false, corporateOptions: [], message: 'Email not registered in the system' });
    }
    if (/multi/.test(username)) {
      return send(200, {
        emailExists: true,
        requiresCorporateSelection: true,
        corporateOptions: [
          { corporateCode: '1000001', corporateName: 'Example Corp' },
          { corporateCode: '2222222', corporateName: 'Second Corp' },
        ],
      });
    }
    return send(200, {
      emailExists: true,
      requiresCorporateSelection: false,
      corporateOptions: [{ corporateCode: '1000001', corporateName: 'Example Corp' }],
    });
  }

  if (path.endsWith('/authentication/corporate-login')) {
    const username = String(body.emailOrUsername ?? '');

    if (body.password === 'wrong') {
      return send(401, { message: 'User not found', success: false, expiredPassword: false, data: null });
    }

    if (/otp/.test(username)) {
      return send(200, {
        success: true,
        message: 'OTP required',
        data: { tempToken: 'temp-token-value', otpType: 'TOTP', username, userId: 7 },
      });
    }

    const token = issueToken(username.split('@')[0] || 'user');
    const data = {
      accessToken: token,
      refreshToken: 'refresh-value',
      username,
      userId: 1747376,
      expireTime: ttlFor(username),
      tokenCreatedDate: Date.now(),
    };
    if (/firstlogin/.test(username)) data.firstLogin = true;

    return send(200, { success: true, message: 'Login successful', data });
  }

  if (path.endsWith('/authentication/validateLoginWithOtpCode')) {
    if (auth.slice(7) !== 'temp-token-value') {
      return send(401, { message: 'Invalid temporary token', success: false });
    }
    const token = issueToken('otp');
    return send(200, {
      success: true,
      data: { accessToken: token, refreshToken: 'refresh-value', username: 'otp-user@example.com', userId: 9, expireTime: 3600 },
    });
  }

  /* --- data -------------------------------------------------------- */

  if (path.endsWith('/merchant-collection/linked-merchants')) {
    if (!requireToken()) return;
    return send(202, envelope([
      {
        id: 2000001,
        fonepayPan: '2222999900000001',
        merchantName: 'Example Farm',
        merchantNickname: 'Example Farm',
        terminalName: 'Example Farm',
        status: 'ACTIVE',
        totalCollections: 0,
        totalTransactions: 0,
      },
    ], 'Linked merchants retrieved'));
  }

  if (path.endsWith('/collections/transactions/summary')) {
    if (!requireToken()) return;
    return send(202, envelope({ totalAmount: 10285, charge: 0, netAmount: 0, totalElements: 19 }, 'Transaction summary retrieved'));
  }

  if (path.endsWith('/collections/transactions/filtered')) {
    if (!requireToken()) return;
    const content = [
      {
        id: '1298700937',
        transactionId: '1301399122',
        merchantId: 210001,
        merchantNickname: 'Example Farm',
        amount: 200,
        paymentStatus: 'Success',
        settlementStatus: 'PENDING',
        localTransactionDate: '2026-09-23 21:29:03',
      },
    ];
    if (state.paidRemarks) {
      // A Nepal-local wall-clock stamp, as the gateway reports it (no offset).
      const localNow = new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
      content.unshift({
        id: '1',
        transactionId: '999',
        merchantId: 210001,
        merchantNickname: 'Example Farm',
        amount: state.paidAmount,
        netAmount: state.paidAmount,
        paymentStatus: 'Success',
        settlementStatus: 'PENDING',
        remarks: state.paidRemarks,
        remarks1: state.paidRemarks,
        localTransactionDate: localNow,
      });
    }
    return send(202, envelope({
      totalAmount: 200,
      pageNumber: 0,
      pageSize: 25,
      totalPages: 2,
      netAmount: 200,
      charge: 0,
      content,
    }, 'Transactions retrieved'));
  }

  if (path.endsWith('/qr/dynamic')) {
    if (!requireToken()) return;
    return send(202, envelope({
      success: true,
      merchantId: 210001,
      terminalId: 214001,
      qrMessage: '00020101021226570011fonepay.com',
      amount: body.amount,
      orderId: body.orderId,
      referenceId: `REF-${body.orderId ?? 'MOCK'}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      websocketId: 'wss://ws.fonepay.com/merchantEndPoint/mock',
      terminalName: 'Example Farm',
      remarks: body.remarks,
    }, 'Dynamic QR code generated'));
  }

  if (path.endsWith('/collections/transactions/my-hierarchy')) {
    if (!requireToken()) return;
    return send(202, envelope({ branches: ['Head Office'] }, 'Hierarchy retrieved'));
  }

  if (path.endsWith('/profile/fetch-user-profile-details')) {
    if (!requireToken()) return;
    return send(200, { fullName: 'Example Operator', email: 'operator@example.com', mobileNumber: '9800000000' });
  }

  return send(404, { message: `no mock route for ${path}`, code: '1', isSuccess: false });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const upstream = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ */
/* Load the real Worker                                                */
/* ------------------------------------------------------------------ */

/*
 * The Worker memoizes reference routes through the Cache API, which Node does
 * not have. Install one that answers only `ref/` keys: renewal and collect keys
 * deliberately miss, so those flows keep the exact behaviour (a null cache)
 * their existing assertions were written against.
 */
const refStore = new Map();
globalThis.caches = {
  default: {
    match: async (request) => {
      const entry = refStore.get(new URL(request.url).pathname);
      return entry === undefined
        ? undefined
        : new Response(entry, { headers: { 'Content-Type': 'application/json' } });
    },
    put: async (request, response) => {
      const key = new URL(request.url).pathname;
      if (key.startsWith('/ref/')) refStore.set(key, await response.text());
    },
  },
};

const outDir = mkdtempSync(join(tmpdir(), 'fonepay-e2e-'));
await build({
  entryPoints: ['src/fonepay/index.ts'],
  outfile: join(outDir, 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error',
});
const worker = (await import(pathToFileURL(join(outDir, 'worker.mjs')).href)).default;

/** Bundle a second module so tests can mint tokens the Worker must accept. */
async function bundleModule(entry, name) {
  const outfile = join(outDir, name);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}

const baseEnv = {
  SESSION_SECRET: randomBytes(32).toString('base64url'),
  FONEPAY_API_BASE_URL: upstream,
  FONEPAY_AUTH_BASE_URL: upstream,
  FONEPAY_ORIGIN: 'https://portal.example.test',
  ALLOWED_ORIGINS: '',
  // The throttle is per-isolate and shared by every call in this file, so keep it
  // clear of the ceiling; its own behaviour is covered by a dedicated env below.
  LOGIN_RATE_LIMIT_PER_MINUTE: '500',
};

const call = (path, { env = baseEnv, ...init } = {}) =>
  worker.fetch(new Request(`http://worker.local${path}`, init), env, {});

const login = async (emailOrUsername, password = 'pw', env = baseEnv, extra = {}) => {
  const res = await call('/api/auth/login', {
    env,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername, password, ...extra }),
  });
  const json = await res.json();
  return { status: res.status, body: json, session: json.data?.session, code: json.code };
};

const post = (path, session, payload = {}, env = baseEnv) =>
  call(path, {
    env,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify(payload),
  });

const countPath = (suffix) => state.calls.filter((entry) => entry.path.endsWith(suffix)).length;

/* ------------------------------------------------------------------ */
/* 1. Sign-in: the bridge runs the corporate lookup itself             */
/* ------------------------------------------------------------------ */

const fresh = await login('operator@example.com');
check('sign-in succeeds without a corporate code', fresh.status === 200 && fresh.body.status === 'SUCCESS', String(fresh.status));
check('sign-in resolves the corporate code', fresh.body.data?.user?.corporateCode === '1000001', fresh.body.data?.user?.corporateCode);
check('sign-in attaches the linked merchants', fresh.body.data?.user?.linkedMerchants?.length === 1);
check('sign-in reports autoRenew on', fresh.body.data?.autoRenew === true);
check('sign-in ran the email lookup', countPath('email-lookup') === 1);
check('sign-in posted to corporate-login', countPath('corporate-login') === 1);
check('sign-in never returns the upstream access token', !JSON.stringify(fresh.body).includes('tok-1-'));

const loginCall = state.calls.filter((entry) => entry.path.endsWith('corporate-login')).at(-1);
check('sign-in sent the portal origin', loginCall?.origin === 'https://portal.example.test');
check('sign-in sent the client code', loginCall?.body.clientCode === 'CORPORATE_USER');
check('sign-in never spoofs a browser UA', !/Mozilla|Chrome|Firefox/i.test(loginCall?.ua ?? ''), loginCall?.ua);

const lookupCall = state.calls.find((entry) => entry.path.endsWith('email-lookup'));
check('lookup sent only the identifier', Object.keys(lookupCall?.body ?? {}).sort().join(',') === 'clientCode,emailOrUsername');

/* ------------------------------------------------------------------ */
/* 1b. Reference routes are answered from an account-scoped cache      */
/* ------------------------------------------------------------------ */

const hierCalls = () => countPath('/collections/transactions/my-hierarchy');
const hierBefore = hierCalls();

const hierHeaders = { Authorization: `Bearer ${fresh.session}` };
const hierFirst = await call('/api/transactions/hierarchy', { headers: hierHeaders });
const hierFirstHeader = hierFirst.headers.get('X-Bridge-Cache');
const hierSecond = await call('/api/transactions/hierarchy', { headers: hierHeaders });
const hierSecondHeader = hierSecond.headers.get('X-Bridge-Cache');

check(
  'the filter tree reaches the gateway on a cold cache',
  hierFirst.status === 202 && hierCalls() === hierBefore + 1,
  `${hierFirst.status} ${hierCalls() - hierBefore}`,
);
check('the cold call carries no cache header', hierFirstHeader === null, String(hierFirstHeader));
check(
  'the repeat call is served from cache',
  hierSecond.status === 202 && hierSecondHeader === 'HIT',
  `${hierSecond.status} ${hierSecondHeader}`,
);
check(
  'the cached answer skips the gateway entirely',
  hierCalls() === hierBefore + 1,
  String(hierCalls() - hierBefore),
);

/* ------------------------------------------------------------------ */
/* 2. Rejections stay opaque                                           */
/* ------------------------------------------------------------------ */

const bad = await login('operator@example.com', 'wrong');
check('a bad password is reported as AUTH_FAILED', bad.status === 401 && bad.code === 'AUTH_FAILED', `${bad.status} ${bad.code}`);
check('the upstream rejection text is not echoed', !/User not found/.test(bad.body.message ?? ''), bad.body.message);

const unknown = await login('unknown@example.com');
check('an unregistered identifier is refused', unknown.status === 401 && unknown.code === 'AUTH_FAILED');

const multi = await login('multi@example.com');
check('multiple corporates require a choice', multi.status === 409 && multi.code === 'CORPORATE_SELECTION_REQUIRED', multi.code);
check('the choices are returned in data', multi.body.data?.corporateOptions?.length === 2, String(multi.body.data?.corporateOptions?.length));

const chosen = await login('multi@example.com', 'pw', baseEnv, { corporateCode: '2222222' });
check('an explicit corporate code skips the lookup', chosen.status === 200);
check(
  'the explicit corporate code is what was sent',
  state.calls.filter((entry) => entry.path.endsWith('corporate-login')).at(-1)?.body.corporateCode === '2222222',
);

/* ------------------------------------------------------------------ */
/* 3. Accounts that cannot be driven headlessly                        */
/* ------------------------------------------------------------------ */

const otp = await login('otp-user@example.com');
check('an OTP account is reported as OTP_REQUIRED', otp.status === 409 && otp.code === 'OTP_REQUIRED', otp.code);
check('a pending session is handed back', typeof otp.body.data?.pendingSession === 'string');
check('the pending session is sealed, not the temp token', !JSON.stringify(otp.body).includes('temp-token-value'));

const otpDone = await call('/api/auth/otp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: otp.body.data.pendingSession, otpCode: '123456' }),
});
const otpBody = await otpDone.json();
check('the OTP step completes the sign-in', otpDone.status === 200 && otpBody.status === 'SUCCESS', `${otpDone.status} ${otpBody.code}`);
check('the completed session reaches data routes', typeof otpBody.data?.session === 'string');

const otpCall = state.calls.filter((entry) => entry.path.endsWith('validateLoginWithOtpCode')).at(-1);
check('the OTP call was authorised with the temp token', otpCall?.auth === 'Bearer temp-token-value');
check('the caller\'s OTP fields are forwarded', otpCall?.body.otpCode === '123456');

const firstLogin = await login('firstlogin@example.com');
check('a password-change account is reported', firstLogin.status === 409 && firstLogin.code === 'PASSWORD_CHANGE_REQUIRED', firstLogin.code);

/* ------------------------------------------------------------------ */
/* 4. Data calls pass the gateway envelope through                     */
/* ------------------------------------------------------------------ */

const summary = await post('/api/transactions/summary', fresh.session, {
  fromTransmissionDateTime: '2026-09-01',
  toTransmissionDateTime: '2026-09-24',
});
const summaryBody = await summary.json();
check('a 202 read is treated as success', summary.status === 202 && summaryBody.isSuccess === true, String(summary.status));
check('the upstream envelope is passed through untouched', summaryBody.code === '0' && summaryBody.message === 'Transaction summary retrieved');
check('the payload is intact', summaryBody.data?.totalElements === 19);

const summaryCall = state.calls.filter((entry) => entry.path.endsWith('transactions/summary')).at(-1);
check('the access token was forwarded upstream', /^Bearer tok-\d+-/.test(summaryCall?.auth ?? ''), summaryCall?.auth);
check('the upstream token is never the bridge session token', summaryCall?.auth.slice(7) !== fresh.session);
check('the date range went out as query', /fromTransmissionDateTime=2026-09-01/.test(summaryCall?.query ?? ''), summaryCall?.query);
check('the body was scoped to the session merchant', summaryCall?.body.merchantId === '2000001', String(summaryCall?.body.merchantId));

const spoof = await post('/api/transactions/summary', fresh.session, { merchantId: '9999999' });
const spoofBody = await spoof.json();
check('a merchant outside the link list is refused', spoof.status === 400 && spoofBody.code === 'INVALID_REQUEST', `${spoof.status} ${spoofBody.code}`);
check(
  'the refused call never reached upstream',
  state.calls.filter((entry) => entry.path.endsWith('transactions/summary')).at(-1)?.body.merchantId === '2000001',
);

const list = await post('/api/transactions', fresh.session, {
  fromTransmissionDateTime: '2026-09-23',
  toTransmissionDateTime: '2026-09-24',
  page: 0,
  size: 25,
});
const listBody = await list.json();
check('a filtered read returns rows', listBody.data?.content?.[0]?.transactionId === '1301399122');
check('the page size reached the query', /size=25/.test(state.calls.filter((entry) => entry.path.endsWith('filtered')).at(-1)?.query ?? ''));

const qr = await post('/api/qr/dynamic', fresh.session, { amount: 250, remarks: 'Milk', orderId: 'INV-9', subMerchantId: 209001, terminalId: 214001 });
const qrBody = await qr.json();
check('a dynamic QR is generated', qr.status === 202 && typeof qrBody.data?.qrMessage === 'string');
check('the QR amount is echoed', qrBody.data?.amount === 250);
const qrCall = state.calls.filter((entry) => entry.path.endsWith('/qr/dynamic')).at(-1);
check('the QR path carries the merchant id', qrCall?.path.endsWith('/linked-merchants/2000001/qr/dynamic'), qrCall?.path);
check('the QR body carries the order reference', qrCall?.body.orderId === 'INV-9');

const profile = await call('/api/profile', {
  headers: { Authorization: `Bearer ${fresh.session}` },
});
const profileBody = await profile.json();
check('a bare, unwrapped response is passed through', profileBody.email === 'operator@example.com', JSON.stringify(profileBody).slice(0, 80));

/* ------------------------------------------------------------------ */
/* 5. Proactive renewal near expiry                                    */
/* ------------------------------------------------------------------ */

const due = await login('due-user@example.com');
check('a near-expiry session signs in', due.status === 200);

const loginsBefore = countPath('corporate-login');
const dueCall = await post('/api/transactions/summary', due.session, {});
const dueBody = await dueCall.json();
const renewedHeader = dueCall.headers.get('X-Session-Token');

check('a near-expiry call still succeeds', dueCall.status === 202 && dueBody.isSuccess === true, `${dueCall.status}`);
check('the bridge signed in again', countPath('corporate-login') === loginsBefore + 1);
check('the renewed session is returned in the header', typeof renewedHeader === 'string' && renewedHeader.length > 40);

// Sign in and call straight away: nothing intervenes, so nothing should renew.
const healthy = await login('healthy@example.com');
const healthyCall = await post('/api/transactions/summary', healthy.session, {});
check('a healthy token is not renewed needlessly', healthyCall.headers.get('X-Session-Token') === null);
check('the healthy call used the first token issued', /^Bearer tok-\d+-healthy$/.test(state.calls.filter((entry) => entry.path.endsWith('transactions/summary')).at(-1)?.auth ?? ''));

/* ------------------------------------------------------------------ */
/* 6. Expiry and the retry-after-401 path                              */
/* ------------------------------------------------------------------ */

const short = await login('short-user@example.com');
const recovered = await post('/api/transactions/summary', short.session, {});
const recoveredBody = await recovered.json();
check('an expired token is recovered transparently', recovered.status === 202 && recoveredBody.isSuccess === true, `${recovered.status}`);
check('recovery returns a fresh session header', typeof recovered.headers.get('X-Session-Token') === 'string');

// The local clock cannot know the gateway invalidated the token early, so the
// only defence is renewing once on a 401 and retrying.
const stale = await login('stale-user@example.com');
state.currentToken = 'tok-invalidated-server-side';
const retried = await post('/api/transactions/summary', stale.session, {});
const retriedBody = await retried.json();
check('a server-side invalidation is recovered once', retried.status === 202 && retriedBody.isSuccess === true, `${retried.status}`);
check('the retry used a fresh token', state.calls.filter((entry) => entry.path.endsWith('transactions/summary')).at(-1)?.auth === `Bearer ${state.currentToken}`);

const noRenewalEnv = { ...baseEnv, FONEPAY_RENEW_ON_EXPIRY: '0' };
const shortOff = await login('short-off-user@example.com', 'pw', noRenewalEnv);
check('a session signs in with renewal disabled', shortOff.status === 200);
const blocked = await post('/api/transactions/summary', shortOff.session, {}, noRenewalEnv);
const blockedBody = await blocked.json();
check('an expired token fails closed when renewal is off', blocked.status === 401 && blockedBody.code === 'SESSION_EXPIRED', `${blocked.status} ${blockedBody.code}`);

// A session that is still healthy, under an env where renewal is off: this is the
// only way to reach the handler and hear about the disabled feature rather than
// being turned away by the session check first.
const healthyOff = await login('healthy-off@example.com', 'pw', noRenewalEnv);
check('a healthy session signs in with renewal disabled', healthyOff.status === 200, String(healthyOff.status));

const refreshOff = await call('/api/auth/refresh', {
  env: noRenewalEnv,
  method: 'POST',
  headers: { Authorization: `Bearer ${healthyOff.session}` },
});
const refreshOffBody = await refreshOff.json();
check('explicit renewal reports missing config', refreshOff.status === 501 && refreshOffBody.code === 'REFRESH_NOT_CONFIGURED', `${refreshOff.status} ${refreshOffBody.code}`);

/* ------------------------------------------------------------------ */
/* 6b. Sign-in throttle                                                */
/* ------------------------------------------------------------------ */

const throttledEnv = { ...baseEnv, LOGIN_RATE_LIMIT_PER_MINUTE: '2' };
await login('throttle-a@example.com', 'pw', throttledEnv);
await login('throttle-b@example.com', 'pw', throttledEnv);
const throttled = await login('throttle-c@example.com', 'pw', throttledEnv);
check('the sign-in throttle eventually refuses', throttled.status === 429 && throttled.code === 'RATE_LIMITED', `${throttled.status} ${throttled.code}`);

const forced = await call('/api/auth/refresh', {
  method: 'POST',
  headers: { Authorization: `Bearer ${fresh.session}` },
});
const forcedBody = await forced.json();
check('explicit renewal re-signs in', forced.status === 200 && forcedBody.data?.session !== fresh.session);

/* ------------------------------------------------------------------ */
/* 7. Session surface and discovery                                    */
/* ------------------------------------------------------------------ */

const me = await call('/api/auth/me', { headers: { Authorization: `Bearer ${fresh.session}` } });
const meBody = await me.json();
check('the session identity is readable', meBody.data?.username === 'operator@example.com' && meBody.data?.corporateCode === '1000001');
check('the session identity leaks no credentials', !JSON.stringify(meBody).includes('pw') && !JSON.stringify(meBody).includes('tok-'));

const missing = await call('/api/transactions/summary', { method: 'POST' });
const missingBody = await missing.json();
check('a missing session is refused', missing.status === 401 && missingBody.code === 'NO_SESSION');

const garbage = await call('/api/transactions/summary', {
  method: 'POST',
  headers: { Authorization: 'Bearer not-a-session' },
});
check('a tampered session is refused', garbage.status === 401 && (await garbage.json()).code === 'INVALID_SESSION');

const health = await call('/api/health');
const healthBody = await health.json();
check('health names the provider', healthBody.data?.provider === 'fonepay');
check('health reports the upstreams', healthBody.data?.api === upstream && healthBody.data?.auth === upstream);

const discovery = await call('/api');
const discoveryBody = await discovery.json();
check('discovery lists the curated routes', discoveryBody.data?.endpoints?.length >= 14, String(discoveryBody.data?.endpoints?.length));
check('discovery names the renewal strategy', discoveryBody.data?.renewal?.strategy === 'sign-in-again');

/* ------------------------------------------------------------------ */
/* Collect — mint a QR, then wait for the payment                      */
/* ------------------------------------------------------------------ */

const collectLogin = await login('collector@example.com');
check('collect session signs in', collectLogin.status === 200);

const collectRes = await post('/api/collect', collectLogin.session, { amount: 250 });
const collectBody = await collectRes.json();
const collectData = collectBody.data ?? {};

check('a collect mints a QR', collectRes.status === 200 && collectData.qrString === '00020101021226570011fonepay.com', `${collectRes.status} ${collectBody.code}`);
check('a collect gets a readable id', /^FP-\d{8}-[0-9A-F]{6}$/.test(collectData.collectId ?? ''), collectData.collectId);
check('a collect writes a unique remark when the caller gives none', /^Bridge collect FP-/.test(collectData.remarks ?? ''), collectData.remarks);
check('a collect reuses its id as the order id', collectData.orderId === collectData.collectId);
check('a collect hands back a status path', String(collectData.statusPath ?? '').startsWith('/api/collect/'), collectData.statusPath);
check('a collect records the reference id', String(collectData.keys?.referenceId ?? '').startsWith('REF-'), collectData.keys?.referenceId);
check('a collect passes the websocket id through', collectData.realtime?.requestId === 'wss://ws.fonepay.com/merchantEndPoint/mock');

const qrRequest = state.calls.filter((entry) => entry.path.endsWith('/qr/dynamic')).at(-1);
check('the QR request carries the collected amount', qrRequest?.body.amount === 250, String(qrRequest?.body.amount));
check('the QR request carries the generated remarks', qrRequest?.body.remarks === collectData.remarks);
check('the QR request is scoped to a linked merchant', /linked-merchants\/2000001\/qr\/dynamic$/.test(qrRequest?.path ?? ''), qrRequest?.path);

const statusPath = collectData.statusPath;
const pendingRes = await call(statusPath, { headers: { Authorization: `Bearer ${collectLogin.session}` } });
const pendingBody = await pendingRes.json();
check('an unpaid collect reports PENDING', pendingRes.status === 200 && pendingBody.data?.state === 'PENDING', pendingBody.data?.state);
check('a pending collect suggests when to ask again', pendingBody.data?.retryAfterMs > 0);

// Pay it: the report now carries a row with our own remarks.
state.paidRemarks = collectData.remarks;
state.paidAmount = 250;
const paidRes = await call(statusPath, { headers: { Authorization: `Bearer ${collectLogin.session}` } });
const paidBody = await paidRes.json();
check('a paid collect reports PAID', paidBody.data?.state === 'PAID', paidBody.data?.state);
check('a paid collect says which field matched', paidBody.data?.matchedBy === 'remarks', paidBody.data?.matchedBy);
check('a paid collect returns the transaction', paidBody.data?.transaction?.transactionId === '999');

const badAmount = await post('/api/collect', collectLogin.session, { amount: 0 });
check('a collect without a usable amount is refused', badAmount.status === 400 && (await badAmount.json()).code === 'INVALID_REQUEST');

state.paidRemarks = '';

const tampered = await call(`${statusPath}ZZ`, { headers: { Authorization: `Bearer ${collectLogin.session}` } });
check('a tampered collect id is refused', tampered.status === 401 && (await tampered.json()).code === 'INVALID_COLLECT');

const anonymous = await call(statusPath);
check('a collect status needs a session', anonymous.status === 401, String(anonymous.status));

const collectModule = await bundleModule('src/shared/collect.ts', 'shared-collect.mjs');
const ticketBase = {
  v: 1,
  provider: 'fonepay',
  collectId: 'FP-20260924-FFFFFF',
  amount: 10,
  remarks: 'Bridge collect FP-20260924-FFFFFF',
  orderId: 'FP-20260924-FFFFFF',
  keys: { remarks: 'x', orderId: 'x' },
  createdAt: Date.now() - 600_000,
  expiresAt: Date.now() - 60_000,
};
const expiredTicket = await collectModule.sealTicket(ticketBase, baseEnv.SESSION_SECRET);
const expiredRes = await call(`/api/collect/${expiredTicket}`, { headers: { Authorization: `Bearer ${collectLogin.session}` } });
check('an expired collect reports EXPIRED', (await expiredRes.json()).data?.state === 'EXPIRED');

const npTicket = await collectModule.sealTicket(
  { ...ticketBase, provider: 'nepalpay', keys: { validationTraceId: 'T' } },
  baseEnv.SESSION_SECRET,
);
const wrongBridge = await call(`/api/collect/${npTicket}`, { headers: { Authorization: `Bearer ${collectLogin.session}` } });
check(
  'a NepalPay collect id is refused by the Fonepay bridge',
  wrongBridge.status === 400 && (await wrongBridge.json()).code === 'WRONG_PROVIDER',
);

/* ------------------------------------------------------------------ */
/* Parallel requests re-sign-in once, not once each                    */
/* ------------------------------------------------------------------ */

// This matters more here than anywhere: renewal posts the stored password, so a
// burst of concurrent requests must not become a burst of sign-ins.
const parallel = await login('operator-expired@example.com');
check('a session that is already expired still signs in', parallel.status === 200);

const burstLoginsBefore = countPath('corporate-login');
await Promise.all([1, 2, 3, 4, 5].map(() => call('/api/merchants', { headers: { Authorization: `Bearer ${parallel.session}` } })));
const burstLoginsAfter = countPath('corporate-login');
check(
  'five parallel expired calls re-sign-in once',
  burstLoginsAfter - burstLoginsBefore === 1,
  String(burstLoginsAfter - burstLoginsBefore),
);

/* ------------------------------------------------------------------ */
/* The bridge key closes the door when configured                      */
/* ------------------------------------------------------------------ */

const keyedEnv = { ...baseEnv, BRIDGE_KEY: 'bridge-secret' };
const healthWithKey = (headers) =>
  worker.fetch(new Request('http://worker.local/api/health', { headers }), keyedEnv, {});

const unkeyed = await healthWithKey({});
check('a closed bridge refuses an unkeyed call', unkeyed.status === 401 && (await unkeyed.json()).code === 'BRIDGE_KEY_REQUIRED');

const wrongKey = await healthWithKey({ 'X-Bridge-Key': 'nope' });
check('a closed bridge refuses the wrong key', wrongKey.status === 401 && (await wrongKey.json()).code === 'BRIDGE_KEY_INVALID');

const rightKey = await healthWithKey({ 'X-Bridge-Key': 'bridge-secret' });
check('a closed bridge admits the right key', rightKey.status === 200);
check('health reports that the bridge is closed', (await rightKey.json()).data?.secure?.bridgeKeyRequired === true);
check('an open bridge reports itself open', (await (await call('/api/health')).json()).data?.secure?.bridgeKeyRequired === false);

const notFound = await call('/api/nope');
check('an unknown route 404s', notFound.status === 404);

const preflight = await call('/api/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://site.example' } });
check('CORS preflight is answered', preflight.status === 204 && preflight.headers.get('Access-Control-Allow-Origin') === '*');
const exposed = preflight.headers.get('Access-Control-Expose-Headers') ?? '';
const allowed = preflight.headers.get('Access-Control-Allow-Headers') ?? '';
check('CORS exposes the renewal header', exposed.includes('X-Session-Token'), exposed);
check('CORS allows the bridge key header', allowed.includes('X-Bridge-Key'), allowed);

// Close keep-alive sockets before the server so Node tears down without tripping
// the libuv handle assertion on Windows.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
rmSync(outDir, { recursive: true, force: true });

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} fonepay e2e checks passed`);
process.exitCode = failed > 0 ? 1 : 0;
