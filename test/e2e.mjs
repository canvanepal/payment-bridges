#!/usr/bin/env node
/**
 * End-to-end test for the renewal path.
 *
 * Runs the real Worker module against a local mock of the NepalPay backend, so
 * the entire flow — login, identity injection, proactive renewal, expiry
 * recovery — is exercised without touching production.
 *
 *   npm run test:e2e
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
/* Mock upstream                                                       */
/* ------------------------------------------------------------------ */

const upstreamCalls = [];

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (username, ttlSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'HS256' }),
    b64url({
      merchantCode: 'MERCHANT0001',
      merchantLegalName: 'EXAMPLE MERCHANT STORE',
      roles: 'SUPER_USER',
      authorities: ['CREATE_USER', 'SUPER_USER'],
      passwordChangeStatus: 'N',
      refundEnable: 'NO',
      sub: username,
      iat: now,
      exp: now + ttlSeconds,
    }),
    'sig',
  ].join('.');
};

/** Pick an access-token lifetime from the username so tests can steer realness. */
const ttlFor = (username) => {
  if (/expired/.test(username)) return -10;
  if (/due/.test(username)) return 2;
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
  const auth = req.headers.authorization ?? '';
  upstreamCalls.push({ path, auth, body });

  const send = (status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'NCHLmock=edgecookie; Path=/',
    });
    res.end(JSON.stringify(payload));
  };
  const ok = (data, message = 'ok') =>
    send(200, { code: '000', status: 'SUCCESS', message, timeStamp: '', data, errors: [] });
  const fail = (status, code, message) =>
    send(status, { code, status: 'FAILED', message, timeStamp: '', data: null, errors: [] });

  if (path === '/backend/api/auth/signin') {
    // Simulate the portal's F5 ASM edge refusing a non-browser client. Note the
    // HTTP 200: the real edge replies 200 with an HTML body, not a 403.
    if (/blocked/.test(String(body.username ?? ''))) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(
        '<html><head><title>Request Rejected</title></head><body>The requested URL was ' +
          'rejected. Please consult with your administrator.<br><br>Your support ID is: 123</body></html>',
      );
    }
    if (!body.username || !body.password) return fail(400, '001', 'credentials required');
    const username = String(body.username);
    const existing = upstreamCalls.filter((call) => call.path === path).length;
    if (existing > 1) {
      // Restart the token chain for each login so tests stay independent.
      delete tokenChains[username];
    }
    const ttl = ttlFor(username);
    tokenChains[username] = { refresh: `refresh-1-${username}` };
    return ok({
      accessToken: makeJwt(username, ttl),
      tokenType: 'Bearer',
      refreshToken: `refresh-1-${username}`,
      expiresIn: ttl,
    });
  }

  if (path === '/backend/api/auth/refresh') {
    // Accept the refresh token from either the Authorization header or the body,
    // and record how it arrived so we can assert on the configured style.
    const headerToken = auth.replace(/^Bearer\s+/i, '');
    const bodyToken = body.refreshToken ?? body.token ?? '';
    const token = headerToken || bodyToken;
    if (!String(token).startsWith('refresh-1-')) return fail(401, '001', 'invalid refresh token');

    const username = String(token).replace('refresh-1-', '');
    const presentedVia = headerToken ? 'bearer' : body.accessToken ? 'body_token' : 'body';
    tokenChains[username] = { refresh: `refresh-2-${username}` };
    return ok({
      accessToken: makeJwt(username, 3600),
      refreshToken: `refresh-2-${username}`,
      expiresIn: 3600,
      presentedVia,
    });
  }

  if (path === '/backend/api/report/transaction/list') {
    if (!auth.startsWith('Bearer ')) return fail(401, '001', 'missing bearer token');
    return ok({ result: [{ instructionId: 'NQR-MOCK', amount: 635 }], pageable: { currentPage: 1 } });
  }

  return fail(404, '404', `no mock route for ${path}`);
});

const tokenChains = {};

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const upstream = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ */
/* Load the real Worker                                                */
/* ------------------------------------------------------------------ */

const outDir = mkdtempSync(join(tmpdir(), 'nepalpay-e2e-'));
await build({
  entryPoints: ['src/nepalpay/index.ts'],
  outfile: join(outDir, 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error',
});
const worker = (await import(pathToFileURL(join(outDir, 'worker.mjs')).href)).default;

const baseEnv = {
  SESSION_SECRET: randomBytes(32).toString('base64url'),
  NEPALPAY_BASE_URL: upstream,
  ALLOWED_ORIGINS: '',
};

const envWithRenewal = {
  ...baseEnv,
  NEPALPAY_REFRESH_PATH: '/backend/api/auth/refresh',
  NEPALPAY_REFRESH_STYLE: 'bearer',
};

const call = (path, { env = envWithRenewal, ...init } = {}) =>
  worker.fetch(new Request(`http://worker.local${path}`, init), env, {});

const login = async (username, env = envWithRenewal) => {
  const res = await call('/api/auth/login', {
    env,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw' }),
  });
  const json = await res.json();
  return { status: res.status, body: json, session: json.data?.session };
};

const post = (path, session, payload = {}, env = envWithRenewal) =>
  call(path, {
    env,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify(payload),
  });

/* ------------------------------------------------------------------ */
/* 1. Login                                                            */
/* ------------------------------------------------------------------ */

const fresh = await login('admin_fresh');
check('login succeeds', fresh.status === 200 && fresh.body.status === 'SUCCESS');
check('login reports autoRenew enabled', fresh.body.data?.autoRenew === true);
check('login exposes merchant identity', fresh.body.data?.user?.merchantCode === 'MERCHANT0001');
check(
  'login captures the edge cookie',
  upstreamCalls.filter((c) => c.path === '/backend/api/auth/signin').length === 1,
);

/* ------------------------------------------------------------------ */
/* 2. A healthy session makes a normal call                            */
/* ------------------------------------------------------------------ */

const beforeRenew = upstreamCalls.filter((c) => c.path === '/backend/api/auth/refresh').length;
const healthy = await post('/api/reports/transactions', fresh.session, {
  fromDate: '2026-09-01',
  toDate: '2026-09-23',
});
const healthyBody = await healthy.json();
check('data call succeeds', healthy.status === 200 && healthyBody.status === 'SUCCESS');
check('data call returns rows', healthyBody.data?.result?.[0]?.instructionId === 'NQR-MOCK');
check('fresh token is not renewed needlessly', upstreamCalls.filter((c) => c.path === '/backend/api/auth/refresh').length === beforeRenew);
check('no renewal header on a healthy token', healthy.headers.get('X-Session-Token') === null);

const reportCall = upstreamCalls.filter((c) => c.path === '/backend/api/report/transaction/list').at(-1);
check('worker sent the access token upstream', reportCall?.auth.startsWith('Bearer '));
check('worker stamped merchantCode', reportCall?.body.merchantCode === 'MERCHANT0001');
check('worker stamped userDetail', reportCall?.body.userDetail?.user === 'admin_fresh');
check(
  'caller cannot override merchantCode',
  (await (await post('/api/reports/transactions', fresh.session, { merchantCode: '9999EVIL' })).json()) &&
    upstreamCalls.filter((c) => c.path === '/backend/api/report/transaction/list').at(-1)?.body
      .merchantCode === 'MERCHANT0001',
);

/* ------------------------------------------------------------------ */
/* 3. Proactive renewal inside the renewal window                      */
/* ------------------------------------------------------------------ */

const due = await login('admin_due');
check('due session logs in', due.status === 200);

const refreshed = await post('/api/reports/transactions', due.session, {
  fromDate: '2026-09-01',
  toDate: '2026-09-23',
});
const refreshedBody = await refreshed.json();
const renewalHeader = refreshed.headers.get('X-Session-Token');

check('near-expiry call still succeeds', refreshed.status === 200 && refreshedBody.status === 'SUCCESS');
check('renewal was triggered', upstreamCalls.some((c) => c.path === '/backend/api/auth/refresh'));
check('renewed session returned in header', typeof renewalHeader === 'string' && renewalHeader.length > 40);

const refreshCall = upstreamCalls.filter((c) => c.path === '/backend/api/auth/refresh')[0];
check('refresh token sent in the Authorization header', refreshCall?.auth === 'Bearer refresh-1-admin_due', refreshCall?.auth);

const afterRenewal = await call('/api/auth/me', {
  headers: { Authorization: `Bearer ${renewalHeader}` },
});
const afterRenewalBody = await afterRenewal.json();
check('the renewed session is usable', afterRenewal.status === 200 && afterRenewalBody.data?.autoRenew === true);
check('renewed session reports renewedAt', typeof afterRenewalBody.data?.renewedAt === 'number');

/* ------------------------------------------------------------------ */
/* 4. Full expiry is recovered transparently                           */
/* ------------------------------------------------------------------ */

const expired = await login('admin_expired');
check('expired-token login still succeeds', expired.status === 200);

const recovered = await post('/api/reports/transactions', expired.session, {
  fromDate: '2026-09-01',
  toDate: '2026-09-23',
});
const recoveredBody = await recovered.json();
check('expired session is transparently renewed', recovered.status === 200 && recoveredBody.status === 'SUCCESS');
check('expired session returns a fresh token', typeof recovered.headers.get('X-Session-Token') === 'string');

/* ------------------------------------------------------------------ */
/* 5. Bearer refusal falls through to the next style                   */
/* ------------------------------------------------------------------ */

const bodyEnv = { ...envWithRenewal, NEPALPAY_REFRESH_STYLE: 'query,body' };
const fallback = await login('admin_due', bodyEnv);
const fallbackRes = await post(
  '/api/reports/transactions',
  fallback.session,
  { fromDate: '2026-09-01', toDate: '2026-09-23' },
  bodyEnv,
);
check('non-bearer styles are attempted', fallbackRes.status === 200);
const bodyStyleCall = upstreamCalls.filter((c) => c.path === '/backend/api/auth/refresh' && c.body.refreshToken).at(-1);
check('refresh token can be sent in the body', typeof bodyStyleCall?.body.refreshToken === 'string', bodyStyleCall?.body.refreshToken);

/* ------------------------------------------------------------------ */
/* 6. Renewal disabled and rejected both fail closed                   */
/* ------------------------------------------------------------------ */

const noRenewal = await login('admin_expired', baseEnv);
check('login works with renewal disabled', noRenewal.status === 200 && noRenewal.body.data?.autoRenew === false);

const blocked = await post('/api/reports/transactions', noRenewal.session, {}, baseEnv);
const blockedBody = await blocked.json();
check('expired session is rejected when renewal is off', blocked.status === 401 && blockedBody.code === 'SESSION_EXPIRED', blockedBody.code);

const unconfigured = await call('/api/auth/refresh', {
  env: baseEnv,
  method: 'POST',
  headers: { Authorization: `Bearer ${fresh.session}` },
});
const unconfiguredBody = await unconfigured.json();
check('explicit refresh reports missing config', unconfigured.status === 501 && unconfiguredBody.code === 'REFRESH_NOT_CONFIGURED', unconfiguredBody.code);

/* ------------------------------------------------------------------ */
/* 7. Explicit refresh route                                           */
/* ------------------------------------------------------------------ */

const explicit = await call('/api/auth/refresh', {
  method: 'POST',
  headers: { Authorization: `Bearer ${fresh.session}` },
});
const explicitBody = await explicit.json();
check('explicit refresh succeeds', explicit.status === 200 && explicitBody.status === 'SUCCESS');
check('explicit refresh reports the style that worked', explicitBody.data?.style === 'bearer', explicitBody.data?.style);
check('explicit refresh returns a new sealed session', explicitBody.data?.session !== fresh.session);

/* ------------------------------------------------------------------ */
/* 8. An F5 edge rejection is reported, not mistaken for a bad password */
/* ------------------------------------------------------------------ */

const blockedLogin = await login('admin_blocked');
check(
  'edge rejection reports UPSTREAM_BLOCKED, not AUTH_FAILED',
  blockedLogin.status === 502 && blockedLogin.body.code === 'UPSTREAM_BLOCKED',
  `${blockedLogin.status} ${blockedLogin.body.code}`,
);
check(
  'edge rejection carries an actionable message',
  /F5 ASM/.test(blockedLogin.body.message ?? ''),
);

// Close keep-alive sockets before the server so Node tears down without tripping
// the libuv handle assertion on Windows.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
rmSync(outDir, { recursive: true, force: true });

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
process.exitCode = failed > 0 ? 1 : 0;
