/**
 * Self-contained test runner.
 *
 * Bundles the pure logic modules (session crypto, payload builder) with esbuild
 * and exercises them directly, so no Worker runtime or network access is needed.
 *
 *   npm test
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const outDir = mkdtempSync(join(tmpdir(), 'nepalpay-test-'));

async function bundle(entry, name) {
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

const results = [];
function check(name, ok, extra = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

const session = {
  v: 1,
  username: 'admin_example',
  accessToken: 'header.payload.signature',
  refreshToken: 'refresh.token.value',
  accessExpiresAt: Date.now() + 3_600_000,
  merchantCode: 'MERCHANT0001',
  merchantLegalName: 'EXAMPLE MERCHANT STORE',
  roles: 'SUPER_USER',
  authorities: ['CREATE_USER', 'SUPER_USER'],
  passwordChangeStatus: 'N',
  refundEnable: 'NO',
  userDetail: {
    user: 'admin_example',
    identificationCode: 'MERCHANT0001',
    subIdentificationCode: 'MERCHANT0001',
  },
  cookies: 'NCHLx=1',
  createdAt: Date.now(),
};

/* ---------------- session sealing ---------------- */

const { sealSession, openSession } = await bundle('src/shared/session.ts', 'session.mjs');
const secret = randomBytes(32).toString('base64url');

const sealed = await sealSession(session, secret);
check('seal emits base64url token', /^[A-Za-z0-9_-]+$/.test(sealed), `${sealed.length} chars`);

const opened = await openSession(sealed, secret);
check(
  'round-trip restores identity',
  opened?.merchantCode === session.merchantCode && opened?.username === session.username,
  opened?.merchantCode,
);
check('upstream access token survives round-trip', opened?.accessToken === session.accessToken);
check('cookie jar survives round-trip', opened?.cookies === session.cookies);

check(
  'tampered token rejected (GCM auth)',
  (await openSession(`${sealed.slice(0, -4)}AAAA`, secret)) === null,
);
check(
  'foreign key rejected',
  (await openSession(sealed, randomBytes(32).toString('base64url'))) === null,
);
check('garbage token rejected', (await openSession('not-a-token', secret)) === null);
check('empty token rejected', (await openSession('', secret)) === null);
check('fresh nonce per seal', (await sealSession(session, secret)) !== sealed);
check(
  'key of the wrong length is rejected loudly',
  await sealSession(session, 'tooshort')
    .then(() => false)
    .catch(() => true),
);

/* ---------------- payload scoping ---------------- */

const { buildPayload, POST_ROUTES } = await bundle('src/nepalpay/routes.ts', 'routes.mjs');
const byPath = (path) => POST_ROUTES.find((spec) => spec.path === path);

const hostile = buildPayload(
  session,
  {
    merchantCode: '9999ATTACKER',
    userDetail: {
      user: 'attacker',
      identificationCode: '9999ATTACKER',
      subIdentificationCode: '9999ATTACKER',
    },
  },
  byPath('/dashboard/transactions'),
);
check(
  'caller-supplied merchantCode is overridden',
  hostile.merchantCode === 'MERCHANT0001',
  String(hostile.merchantCode),
);
check(
  'caller-supplied userDetail is overridden',
  hostile.userDetail.user === 'admin_example',
  String(hostile.userDetail.user),
);

const network = buildPayload(session, {}, byPath('/reports/network'));
check(
  'network report uses requestUserDetailDto',
  network.requestUserDetailDto?.user === 'admin_example',
);
check('network report omits merchantCode', network.merchantCode === undefined);
check('network report omits userDetail', network.userDetail === undefined);

check(
  'stores receives default pageable',
  buildPayload(session, {}, byPath('/stores')).pageable?.rowPerPage === 10,
);

const paged = buildPayload(session, { pageable: { currentPage: 3 } }, byPath('/reports/transactions'));
check(
  'caller page merges over route defaults',
  paged.pageable.currentPage === 3 && paged.pageable.rowPerPage === 10,
  JSON.stringify(paged.pageable),
);

const report = buildPayload(
  session,
  { fromDate: '2026-09-01', toDate: '2026-09-23', storeLabel: 'Store1' },
  byPath('/reports/transactions'),
);
check(
  'business inputs pass through untouched',
  report.fromDate === '2026-09-01' &&
    report.toDate === '2026-09-23' &&
    report.storeLabel === 'Store1',
);

const qr = buildPayload(session, { amount: 635, remarks: 'yo' }, byPath('/qr'));
check('qr keeps amount and remarks', qr.amount === 635 && qr.remarks === 'yo');

check(
  'every identity-bearing route carries an identity block',
  POST_ROUTES.filter((spec) => (spec.identity ?? 'full') === 'full').every((spec) => {
    const key = spec.contextKey ?? 'userDetail';
    return buildPayload(session, {}, spec)[key]?.user === session.userDetail.user;
  }),
);

check(
  'reference lookups inject no identity at all',
  POST_ROUTES.filter((spec) => spec.identity === 'none').length > 0 &&
    POST_ROUTES.filter((spec) => spec.identity === 'none').every((spec) => {
      const body = buildPayload(session, {}, spec);
      return body.merchantCode === undefined && body.userDetail === undefined;
    }),
);

check(
  'reference lookups still honour caller input',
  Object.keys(buildPayload(session, { bankId: '7' }, byPath('/banks'))).length === 1,
);

const balance = buildPayload(session, {}, byPath('/dashboard/balance'));
check('balance route injects merchantCode + userDetail', balance.merchantCode === session.merchantCode && balance.userDetail.user === session.userDetail.user);

const terminalQr = buildPayload(session, { amount: 5 }, byPath('/qr/terminal'));
check(
  'terminal QR keeps caller amount over its default store/terminal',
  terminalQr.amount === 5 && terminalQr.storeLabel === 'Store1',
);

check(
  'GET routes are declared as GET',
  ['/dashboard/images', '/refunds/reasons', '/users/roles'].every((p) => byPath(p)?.method === 'GET'),
);
check(
  'every route has a unique bridge path and upstream',
  new Set(POST_ROUTES.map((s) => s.path)).size === POST_ROUTES.length &&
    new Set(POST_ROUTES.map((s) => s.upstream)).size === POST_ROUTES.length,
);
check(
  'every route is documented with a title',
  POST_ROUTES.every((spec) => typeof spec.title === 'string' && spec.title.length > 0),
);
check(
  'reports default to an empty date range rather than a hardcoded one',
  buildPayload(session, {}, byPath('/reports/transactions')).fromDate === '',
);

check('route count is stable', POST_ROUTES.length === 21, `${POST_ROUTES.length} routes`);

/* ---------------- edge / WAF rejection detection ---------------- */

const { isBlockedResponse } = await bundle('src/nepalpay/client.ts', 'nepalpay.mjs');

const F5_PAGE =
  "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. " +
  "Please consult with your administrator.<br><br>Your support ID is: 8394931668403348859</body></html>";

check('detects the F5 rejection page', isBlockedResponse('text/html', F5_PAGE) === true);
check(
  'detects the TSPD challenge script',
  isBlockedResponse('text/html; charset=utf-8', '<script src="/TSPD/abc?type=5"></script>') === true,
);
check(
  'detects a Cloudflare 52x origin error',
  isBlockedResponse('text/plain; charset=UTF-8', 'error code: 520') === true,
);
check(
  'detects a 523 origin error too',
  isBlockedResponse('text/plain', 'error code: 523') === true,
);
check(
  'does not flag a JSON body that merely mentions 520',
  isBlockedResponse('application/json', '{"message":"error code: 520"}') === false,
);
check('does not flag normal JSON envelopes', isBlockedResponse('application/json', '{"code":"000"}') === false);
check('does not flag unrelated HTML', isBlockedResponse('text/html', '<html><body>hello</body></html>') === false);
check('does not flag the marker without html content type', isBlockedResponse('application/json', F5_PAGE) === false);

/* ---------------- refresh configuration + parsing ---------------- */

const { parseRefreshStyles, extractTokens, expiryFromToken, applyRefresh } = await bundle(
  'src/nepalpay/refresh.ts',
  'refresh.mjs',
);

const styles = (value) => parseRefreshStyles(value).join(',');
check('refresh style defaults to bearer', styles(undefined) === 'bearer');
check('refresh style empty falls back to bearer', styles('') === 'bearer');
check('refresh style single value parsed', styles('body') === 'body');
check('refresh style list parsed in order', styles('bearer, body') === 'bearer,body');
check('refresh style is case-insensitive', styles('BEARER,Query') === 'bearer,query');
check('refresh style ignores unknown values', styles('nonsense') === 'bearer');
check('refresh style keeps known values from a mixed list', styles('nope,bearer,junk') === 'bearer');

check(
  'extractTokens reads the standard sign-in shape',
  extractTokens({ status: 'SUCCESS', data: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 } })
    ?.accessToken === 'a',
);
check('extractTokens reads a top-level token', extractTokens({ accessToken: 'top' })?.accessToken === 'top');
check(
  'extractTokens reads snake_case',
  extractTokens({ data: { access_token: 'snake' } })?.accessToken === 'snake',
);
check(
  'extractTokens reads a doubly nested token',
  extractTokens({ data: { data: { token: 'deep' } } })?.accessToken === 'deep',
);
check('extractTokens reads a result wrapper', extractTokens({ result: { jwt: 'res' } })?.accessToken === 'res');
check(
  'extractTokens parses a string expiresIn',
  extractTokens({ data: { accessToken: 'a', expires_in: '900' } })?.expiresIn === 900,
);
check('extractTokens returns null without an access token', extractTokens({ data: { refreshToken: 'r' } }) === null);
check('extractTokens returns null for null', extractTokens(null) === null);
check('extractTokens returns null for a string', extractTokens('nope') === null);
check('extractTokens returns null for an empty object', extractTokens({}) === null);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
check('expiryFromToken converts exp to ms', expiryFromToken(jwt({ exp: 1790108169 })) === 1790108169000);
check('expiryFromToken returns null without exp', expiryFromToken(jwt({ sub: 'x' })) === null);
check('expiryFromToken returns null for garbage', expiryFromToken('not-a-jwt') === null);

const renewed = applyRefresh(session, {
  tokens: { accessToken: 'new.access.token' },
  cookies: 'NCHLnew=2',
  expiresAt: 1_800_000_000_000,
  style: 'bearer',
});
check('applyRefresh swaps the access token', renewed.accessToken === 'new.access.token');
check('applyRefresh adopts the new expiry', renewed.accessExpiresAt === 1_800_000_000_000);
check('applyRefresh keeps the old refresh token when none returned', renewed.refreshToken === session.refreshToken);
check('applyRefresh updates cookies', renewed.cookies === 'NCHLnew=2');
check('applyRefresh stamps renewedAt', typeof renewed.renewedAt === 'number');
check('applyRefresh preserves identity', renewed.merchantCode === session.merchantCode && renewed.userDetail === session.userDetail);

const rotated = applyRefresh(session, {
  tokens: { accessToken: 'a2', refreshToken: 'rotated.refresh' },
  cookies: '',
  expiresAt: 1,
  style: 'body',
});
check('applyRefresh adopts a rotated refresh token', rotated.refreshToken === 'rotated.refresh');
check('applyRefresh keeps existing cookies when upstream sends none', rotated.cookies === session.cookies);

/* ---------------- upstream header profiles ---------------- */

const headers = await bundle('src/shared/headers.ts', 'headers.mjs');
const ff = headers.upstreamHeaders({
  mode: 'browser',
  origin: 'https://business.nepalpay.com.np',
  hasBody: true,
});
check('browser mode still spoofs a browser UA (diagnostic control)', /Firefox\//.test(ff['User-Agent'] ?? ''));

// This is the regression that cost hours: a browser UA on a non-browser TLS
// connection makes the edge reject the request before the API ever sees it.
for (const mode of ['minimal', 'product', 'curl']) {
  const built = headers.upstreamHeaders({
    mode,
    origin: 'https://business.nepalpay.com.np',
    hasBody: true,
  });
  const ua = built['User-Agent'] ?? '';
  check(
    `${mode} mode never sends a browser User-Agent`,
    !/Mozilla\/|Firefox\/|Chrome\//.test(ua),
    ua || '(none)',
  );
  check(`${mode} mode asks for JSON`, built.Accept === 'application/json, text/plain, */*');
  check(`${mode} mode sets Content-Type when there is a body`, built['Content-Type'] === 'application/json');
}

const authed = headers.upstreamHeaders({
  mode: 'minimal',
  origin: 'https://business.nepalpay.com.np',
  hasBody: false,
  accessToken: 'tok',
  cookies: 'NCHLx=1',
});
check('auth headers are always applied', authed.Authorization === 'Bearer tok' && authed.Cookie === 'NCHLx=1');
check('no Content-Type on a bodyless request', authed['Content-Type'] === undefined);
check('minimal mode sends no Origin/Referer', !authed.Origin && !authed.Referer);

check('default header mode is minimal', headers.parseHeaderMode(undefined) === 'minimal');
check('unknown header mode falls back to minimal', headers.parseHeaderMode('Mozilla') === 'minimal');
check('header mode parsing is case-insensitive', headers.parseHeaderMode(' CURL ') === 'curl');
check('every advertised mode is parseable', headers.HEADER_MODES.every((m) => headers.parseHeaderMode(m) === m));

const nepalpay = await bundle('src/nepalpay/client.ts', 'nepalpay.mjs');
check('isBlockedResponse flags the F5 HTML page', nepalpay.isBlockedResponse('text/html', '<title>Request Rejected</title>'));
check('isBlockedResponse flags a 52x body', nepalpay.isBlockedResponse('text/plain', 'error code: 520'));
check('isBlockedResponse passes a JSON envelope', !nepalpay.isBlockedResponse('application/json', '{"code":"400"}'));

/* ---------------- Fonepay: request building ---------------- */

const fpClient = await bundle('src/fonepay/client.ts', 'fonepay-client.mjs');
const fpRoutes = await bundle('src/fonepay/routes.ts', 'fonepay-routes.mjs');

const fonepaySession = {
  v: 1,
  provider: 'fonepay',
  accessToken: 'header.payload.signature.tag',
  refreshToken: 'refresh-value',
  tempToken: '',
  accessExpiresAt: Date.now() + 600_000,
  signedInAt: Date.now(),
  username: 'operator@example.com',
  corporateCode: '1000001',
  userId: '1747376',
  displayName: 'Example Operator',
  otpType: '',
  linkedMerchants: [
    { id: 2000001, merchantName: 'Example Farm', merchantNickname: 'Example Farm', fonepayPan: '2222999900000001' },
  ],
  credentials: { emailOrUsername: 'operator@example.com', password: 'pw' },
};

const specOf = (path) => fpRoutes.FONEPAY_ROUTES.find((spec) => spec.path === path);

const txnRequest = fpRoutes.buildFonepayRequest(fonepaySession, specOf('/transactions'), {
  fromTransmissionDateTime: '2026-09-01',
  toTransmissionDateTime: '2026-09-24',
});
check('transactions route defaults size to 25', /size=25/.test(txnRequest.query), txnRequest.query);
check('transactions route carries the date range as query', /fromTransmissionDateTime=2026-09-01/.test(txnRequest.query));
check(
  'transactions route scopes the body to the session merchant',
  txnRequest.body?.merchantId === '2000001',
  String(txnRequest.body?.merchantId),
);
check('transactions route is a POST with a body', typeof txnRequest.body === 'object');

const overridden = fpRoutes.buildFonepayRequest(fonepaySession, specOf('/transactions'), { size: 100, page: 3 });
check('caller can override query defaults', /size=100/.test(overridden.query) && /page=3/.test(overridden.query), overridden.query);

const hierarchyRequest = fpRoutes.buildFonepayRequest(fonepaySession, specOf('/merchants/hierarchy'), {});
check(
  'path placeholders are filled from the session',
  hierarchyRequest.path.endsWith('/linked-merchants/2000001/hierarchy'),
  hierarchyRequest.path,
);
check('a GET route carries no body', hierarchyRequest.body === undefined);

const staticQr = fpRoutes.buildFonepayRequest(fonepaySession, specOf('/qr/static'), {
  subMerchantId: 209001,
  terminalId: 214001,
});
check('static QR path takes the merchant id', staticQr.path.endsWith('/linked-merchants/2000001/qr/generate'), staticQr.path);
check('static QR passes sub-merchant and terminal as query', /subMerchantId=209001/.test(staticQr.query) && /terminalId=214001/.test(staticQr.query));

let scopeRejected = false;
try {
  fpRoutes.buildFonepayRequest(fonepaySession, specOf('/transactions'), { merchantId: '9999999' });
} catch (error) {
  scopeRejected = error instanceof fpRoutes.ScopeError;
}
check('a merchant outside the linked list is refused', scopeRejected);

let missingParam = false;
try {
  fpRoutes.buildFonepayRequest(fonepaySession, specOf('/transactions/detail'), {});
} catch (error) {
  missingParam = error instanceof fpRoutes.ScopeError;
}
check('a missing required path parameter is refused', missingParam);

const unverified = fpRoutes.buildFonepayRequest(
  { ...fonepaySession, linkedMerchants: [] },
  specOf('/transactions'),
  { merchantId: '555' },
);
check(
  'an unverified merchant list does not lock the caller out',
  unverified.body?.merchantId === '555',
  String(unverified.body?.merchantId),
);

check('every route has a unique bridge path',
  new Set(fpRoutes.FONEPAY_ROUTES.map((spec) => spec.method + spec.path)).size === fpRoutes.FONEPAY_ROUTES.length);
check('every route upstream starts with /corporate/',
  fpRoutes.FONEPAY_ROUTES.every((spec) => spec.upstream.startsWith('/corporate/')));

/* ---------------- Fonepay: login parsing and expiry ---------------- */

const flatLogin = fpClient.extractLoginData({ accessToken: 'a.b.c', expireTime: 600, username: 'user' });
check('flat login response is understood', flatLogin.accessToken === 'a.b.c');

const nestedLogin = fpClient.extractLoginData({ isSuccess: true, data: { accessToken: 'x.y.z', expireTime: 300 } });
check('login nested in data is understood', nestedLogin.accessToken === 'x.y.z');

const tempOnly = fpClient.extractLoginData({ success: true, data: { tempToken: 'temp', otpType: 'TOTP' } });
check('a temp-token-only response yields no access token', !tempOnly.accessToken, tempOnly.accessToken ?? '');
check('a temp-token-only response still exposes the OTP type', tempOnly.otpType === 'TOTP');

const now = 1_700_000_000_000;
check('expireTime as a duration becomes a future ms timestamp', fpClient.expiryFromLogin({ expireTime: 900 }, now) === now + 900_000);
check('expireTime in epoch seconds is converted', fpClient.expiryFromLogin({ expireTime: 1_800_000_000 }, now) === 1_800_000_000_000);
check('expireTime in epoch ms is kept', fpClient.expiryFromLogin({ expireTime: 1_800_000_000_000 }, now) === 1_800_000_000_000);
check(
  'an unparseable expireTime falls back to a short TTL',
  fpClient.expiryFromLogin({ expireTime: 'nonsense' }, now) === now + fpClient.FALLBACK_TTL_MS,
);
check('a missing expireTime falls back to a short TTL', fpClient.expiryFromLogin({}, now) === now + fpClient.FALLBACK_TTL_MS);
check('the fallback TTL is under ten minutes', fpClient.FALLBACK_TTL_MS <= 600_000);

const merchantsBare = fpClient.extractLinkedMerchants([{ id: 1, merchantName: 'A' }, { id: 2 }]);
check('linked merchants parse from a bare array', merchantsBare.length === 2 && merchantsBare[1].id === 2);
const merchantsWrapped = fpClient.extractLinkedMerchants({ data: [{ id: 3, fonepayPan: '222' }] });
check('linked merchants parse from data', merchantsWrapped[0].fonepayPan === '222');
check('linked merchants drop entries without an id', fpClient.extractLinkedMerchants([{ merchantName: 'no id' }]).length === 0);

check('default merchant id is the first linked merchant',
  fpClient.defaultMerchantId(fonepaySession) === '2000001');
check('default merchant id is empty without a list',
  fpClient.defaultMerchantId({ linkedMerchants: [] }) === '');
check('a linked merchant is allowed',
  fpClient.merchantIsAllowed(fonepaySession, '2000001'));
check('an unlinked merchant is refused',
  !fpClient.merchantIsAllowed(fonepaySession, '1'));

const fpHeaders = fpClient.upstreamHeaders({ env: { SESSION_SECRET: 'x' }, hasBody: true, accessToken: 'tok' });
check('fonepay headers send the bearer token', fpHeaders.Authorization === 'Bearer tok');
check('fonepay headers send the portal origin', fpHeaders.Origin === 'https://fonebiz.fonepay.com');
check('fonepay headers send a matching referer', fpHeaders.Referer === 'https://fonebiz.fonepay.com/');
check('fonepay headers never spoof a browser UA', !/Mozilla|Chrome|Firefox/i.test(fpHeaders['User-Agent'] ?? ''));
check('fonepay headers set Content-Type only with a body',
  fpHeaders['Content-Type'] === 'application/json' &&
    fpClient.upstreamHeaders({ env: {}, hasBody: false })['Content-Type'] === undefined);
check('fonepay base urls default to the corporate gateway',
  fpClient.apiBase({}) === 'https://corporate-kong.fonepay.com/corporate/api' &&
    fpClient.authBase({}) === 'https://corporate-kong.fonepay.com/corporate/auth');
check('fonepay base urls can be overridden', fpClient.apiBase({ FONEPAY_API_BASE_URL: 'http://127.0.0.1:9/x/' }) === 'http://127.0.0.1:9/x');
check('client code defaults to CORPORATE_USER', fpClient.clientCode({}) === 'CORPORATE_USER');

/* ---------------- Shared: bridge key ---------------- */

const bridgeKey = await bundle('src/shared/bridge-key.ts', 'bridge-key.mjs');

check('the bridge key header is X-Bridge-Key', bridgeKey.BRIDGE_KEY_HEADER === 'X-Bridge-Key');
check('a blank bridge key counts as unset', bridgeKey.bridgeKeyOf({ BRIDGE_KEY: '   ' }) === null);
check('a missing bridge key counts as unset', bridgeKey.bridgeKeyOf({}) === null);
check('a configured bridge key is trimmed and returned', bridgeKey.bridgeKeyOf({ BRIDGE_KEY: ' k ' }) === 'k');
check('equal secrets match', bridgeKey.secretsMatch('s3cret', 's3cret'));
check('a differing secret does not match', !bridgeKey.secretsMatch('s3cret', 's3cres'));
check('a prefix of the secret does not match', !bridgeKey.secretsMatch('s3cret', 's3cret-longer'));
check('an empty presented secret does not match', !bridgeKey.secretsMatch('', 's3cret'));

/** Run the middleware against a stub context that only implements what it uses. */
const runBridgeKey = async (env, presented) => {
  let passed = false;
  const outcome = await bridgeKey.requireBridgeKey()(
    {
      env,
      req: { header: () => presented },
      json: (body, status) => ({ body, status }),
    },
    async () => {
      passed = true;
    },
  );
  return { outcome, passed };
};

const openBridge = await runBridgeKey({}, undefined);
check('an unconfigured bridge lets calls through', openBridge.passed && openBridge.outcome === undefined);

const missingKey = await runBridgeKey({ BRIDGE_KEY: 'k' }, undefined);
check(
  'a closed bridge refuses a caller with no key',
  missingKey.outcome?.status === 401 && missingKey.outcome?.body?.code === 'BRIDGE_KEY_REQUIRED',
  missingKey.outcome?.body?.code,
);

const wrongKey = await runBridgeKey({ BRIDGE_KEY: 'k' }, 'nope');
check(
  'a closed bridge refuses the wrong key',
  wrongKey.outcome?.status === 401 && wrongKey.outcome?.body?.code === 'BRIDGE_KEY_INVALID',
  wrongKey.outcome?.body?.code,
);

const rightKey = await runBridgeKey({ BRIDGE_KEY: 'k' }, 'k');
check('a closed bridge admits the right key', rightKey.passed && rightKey.outcome === undefined);

/* ---------------- Shared: collect primitives ---------------- */

const collect = await bundle('src/shared/collect.ts', 'collect.mjs');

check(
  'a collect id is prefixed, dated and random',
  /^NP-\d{8}-[0-9A-F]{6}$/.test(collect.newCollectId('NP', Date.parse('2026-09-24T10:00:00Z'))),
  collect.newCollectId('NP', Date.parse('2026-09-24T10:00:00Z')),
);
check('two collect ids differ', collect.newCollectId('NP') !== collect.newCollectId('NP'));
check('an amount parses from a string', collect.parseAmount('125.50') === 125.5);
check('an amount is rounded to paisa', collect.parseAmount(10.005) === 10.01 || collect.parseAmount(10.005) === 10,
  String(collect.parseAmount(10.005)));
check('a zero amount is refused', collect.parseAmount(0) === null);
check('a negative amount is refused', collect.parseAmount('-5') === null);
check('a non-numeric amount is refused', collect.parseAmount('abc') === null);
check('a missing amount is refused', collect.parseAmount(undefined) === null);
check('amounts compare within a paisa', collect.amountsEqual(100, 100.005));
check('a two-paisa gap is not the same amount', !collect.amountsEqual(100, 100.02));
check(
  'a ticket ttl is clamped to the supported range',
  collect.clampTtl(5) === 60 && collect.clampTtl(100_000) === 900 && collect.clampTtl(undefined) === 600 && collect.clampTtl(300) === 300,
);
check(
  'rows are found under result, content and list',
  collect.rowsFrom({ data: { result: [1, 2] } }).length === 2 &&
    collect.rowsFrom({ content: [1] }).length === 1 &&
    collect.rowsFrom({ list: [1, 2, 3] }).length === 3,
);
check('an unknown envelope shape yields no rows', collect.rowsFrom({ total: 5 }).length === 0);
check('a null payload yields no rows', collect.rowsFrom(null).length === 0);
check('a row carrying a correlation value is recognised', collect.rowCarriesValue({ addnField3: 'TRACE-1' }, ['trace-1']));
check('an identifier nested in the row is recognised', collect.rowCarriesValue({ data: { payer: { ref: 'abc' } } }, ['ABC']));
check('an identifier in a list inside the row is recognised', collect.rowCarriesValue({ refs: [{ id: 'T9' }] }, ['T9']));
check('an unrelated row is not a match', !collect.rowCarriesValue({ instructionId: 'NQR-1' }, ['TRACE-1']));
check('a numeric row field matches as a string', collect.rowCarriesValue({ sessionSrlNo: 14518 }, ['14518']));

const createdAt = Date.parse('2026-09-24T10:00:00Z');
check(
  'an ISO timestamp inside the window is accepted',
  collect.withinWindow(new Date(createdAt + 60_000).toISOString(), { createdAt }),
);
check(
  'an ISO timestamp before the window is rejected',
  !collect.withinWindow(new Date(createdAt - 3_600_000).toISOString(), { createdAt }),
);
check('an unparseable timestamp is rejected', !collect.withinWindow('not a date', { createdAt }));
check('a missing timestamp is rejected', !collect.withinWindow(undefined, { createdAt }));
check(
  'a Nepal-local "YYYY-MM-DD HH:MM:SS" stamp is pinned to +05:45',
  collect.withinWindow('2026-09-24 15:45:00', { createdAt }),
);
check(
  'a Nepal-local stamp is not read as UTC',
  !collect.withinWindow('2026-09-24 09:00:00', { createdAt }),
);

/* ---------------- Shared: collect ticket sealing ---------------- */

const ticketPayload = {
  v: 1,
  provider: 'nepalpay',
  collectId: 'NP-20260924-ABCDEF',
  amount: 100,
  remarks: 'Bridge collect NP-20260924-ABCDEF',
  orderId: 'NP-20260924-ABCDEF',
  keys: { validationTraceId: 'TRACE-1' },
  createdAt,
  expiresAt: createdAt + 600_000,
};

const sealedTicket = await collect.sealTicket(ticketPayload, secret);
const openedTicket = await collect.openTicket(sealedTicket, secret);
check('a collect ticket round-trips', openedTicket?.keys.validationTraceId === 'TRACE-1');
check(
  'a collect ticket sealed with another secret is refused',
  (await collect.openTicket(sealedTicket, randomBytes(32).toString('base64url'))) === null,
);
check('a mangled collect ticket is refused', (await collect.openTicket(`${sealedTicket}AAA`, secret)) === null);
check('a session token is not accepted as a collect ticket', (await collect.openTicket(sealed, secret)) === null);
check('a collect token is not accepted as a session', (await openSession(sealedTicket, secret)) === null);

/* ---------------- NepaliPay: payment matching ---------------- */

const npCollect = await bundle('src/nepalpay/collect.ts', 'np-collect.mjs');
const npValues = Object.values(ticketPayload.keys);

check(
  'a row carrying the collected trace id is a match',
  npCollect.matchRow({ validationTraceId: 'TRACE-1', amount: 100 }, ticketPayload, npValues)?.matchedBy ===
    'validationTraceId',
);
check(
  'a matching trace id with the wrong amount is not a payment',
  npCollect.matchRow({ validationTraceId: 'TRACE-1', amount: 999 }, ticketPayload, npValues) === null,
);
check(
  'a row with no ids but the right amount and a fresh time matches',
  npCollect.matchRow(
    { amount: 100, localTransactionDateTime: new Date(createdAt + 30_000).toISOString() },
    ticketPayload,
    npValues,
  )?.matchedBy === 'amount+time',
);
check(
  'a stale row with the right amount is not a match',
  npCollect.matchRow(
    { amount: 100, localTransactionDateTime: new Date(createdAt - 6 * 3_600_000).toISOString() },
    ticketPayload,
    npValues,
  ) === null,
);
check(
  'an identifier found in an undocumented field still matches',
  npCollect.matchRow({ amount: 100, addnField7: 'TRACE-1' }, ticketPayload, npValues)?.matchedBy === 'value-scan',
);
check(
  'the order id in merchantTxnRef counts as a match',
  npCollect.matchRow(
    { amount: 100, merchantTxnRef: 'NP-20260924-ABCDEF,bill' },
    ticketPayload,
    npValues,
  ) === null,
  'a composite ref is not an exact equality match',
);
check('a non-object row is ignored', npCollect.matchRow('nope', ticketPayload, npValues) === null);
check('a null row is ignored', npCollect.matchRow(null, ticketPayload, npValues) === null);

/* ---------------- Fonepay: payment matching ---------------- */

const fpCollect = await bundle('src/fonepay/collect.ts', 'fp-collect.mjs');
const fpTicketPayload = {
  ...ticketPayload,
  provider: 'fonepay',
  collectId: 'FP-20260924-123456',
  amount: 250,
  remarks: 'Bridge collect FP-20260924-123456',
  orderId: 'FP-20260924-123456',
  keys: { remarks: 'Bridge collect FP-20260924-123456', orderId: 'FP-20260924-123456' },
};
const fpValues = Object.values(fpTicketPayload.keys);

check(
  'a Fonepay row with the collected remarks is a match',
  fpCollect.matchRow(
    { remarks: 'Bridge collect FP-20260924-123456', amount: 250, paymentStatus: 'Success' },
    fpTicketPayload,
    fpValues,
  )?.matchedBy === 'remarks',
);
check(
  'the second remarks column also matches',
  fpCollect.matchRow(
    { remarks1: 'Bridge collect FP-20260924-123456', amount: 250, paymentStatus: 'Success' },
    fpTicketPayload,
    fpValues,
  )?.matchedBy === 'remarks1',
);
check(
  'a failed payment with the right remarks is not a payment',
  fpCollect.matchRow(
    { remarks: 'Bridge collect FP-20260924-123456', amount: 250, paymentStatus: 'Failed' },
    fpTicketPayload,
    fpValues,
  ) === null,
);
check(
  'another merchant paying the same amount is not a payment',
  fpCollect.matchRow({ remarks: 'lunch', amount: 250, paymentStatus: 'Success' }, fpTicketPayload, fpValues) ===
    null,
);
check(
  'the order id echoed into referenceId matches',
  fpCollect.matchRow(
    { referenceId: 'FP-20260924-123456', amount: 250, paymentStatus: 'Success' },
    fpTicketPayload,
    fpValues,
  )?.matchedBy === 'referenceId',
);

/* ---------------- Shared: json cache ---------------- */

const kvcache = await bundle('src/shared/kvcache.ts', 'kvcache.mjs');

const fakeCache = () => {
  const store = new Map();
  return {
    store,
    match: async (request) => {
      const hit = store.get(request.url);
      return hit ? new Response(hit, { headers: { 'Content-Type': 'application/json' } }) : undefined;
    },
    put: async (request, response) => {
      store.set(request.url, await response.text());
    },
  };
};

check('a hash key is 32 hex characters', /^[0-9a-f]{32}$/.test(await kvcache.hashKey('anything')));
check('a hash key is stable', (await kvcache.hashKey('a')) === (await kvcache.hashKey('a')));
check('different inputs hash differently', (await kvcache.hashKey('a')) !== (await kvcache.hashKey('b')));

const cacheStore = fakeCache();
check('a missing cache entry reads as null', (await kvcache.cacheGet(cacheStore, 'nope')) === null);
await kvcache.cachePut(cacheStore, 'k', { sealed: 's' }, 30);
check('a written entry reads back', (await kvcache.cacheGet(cacheStore, 'k'))?.sealed === 's');
check('an absent cache never throws', (await kvcache.cacheGet(null, 'k')) === null);
await kvcache.cachePut(null, 'k', { sealed: 's' }, 30);

const throwingCache = {
  match: async () => {
    throw new Error('no cache here');
  },
  put: async () => {
    throw new Error('no cache here');
  },
};
check('a throwing cache degrades to a miss', (await kvcache.cacheGet(throwingCache, 'k')) === null);
check(
  'a throwing cache does not fail the write',
  (await kvcache.cachePut(throwingCache, 'k', {}, 30)) === undefined,
);

let collapsed = 0;
const registry = new Map();
const burst = await Promise.all(
  [1, 2, 3, 4].map(() =>
    kvcache.inFlightOnce(registry, 'same', async () => {
      collapsed += 1;
      return 'done';
    }),
  ),
);
check('a concurrent burst runs the work once', collapsed === 1, String(collapsed));
check('every caller in the burst gets the result', burst.every((value) => value === 'done'));
check('the registry is emptied afterwards', registry.size === 0);

/* ---------------- Shared: renewal de-duplication ---------------- */

const renewal = await bundle('src/shared/renewal.ts', 'renewal.mjs');

let renewCalls = 0;
const renewalCache = fakeCache();
const renewResults = await Promise.all(
  [1, 2, 3].map(() =>
    renewal.renewOnce({
      sessionToken: 'session-token-1',
      cache: renewalCache,
      renew: async () => {
        renewCalls += 1;
        return 'sealed-session';
      },
    }),
  ),
);
check('a burst of renewals collapses into one upstream call', renewCalls === 1, String(renewCalls));
check('every caller receives the renewed session', renewResults.every((value) => value === 'sealed-session'));

// A second isolate has its own in-flight map but the same cache.
renewal.resetRenewals();
let secondIsolateCalls = 0;
const reused = await renewal.renewOnce({
  sessionToken: 'session-token-1',
  cache: renewalCache,
  renew: async () => {
    secondIsolateCalls += 1;
    return 'sealed-session-2';
  },
});
check('another isolate reuses the cached renewal', secondIsolateCalls === 0 && reused === 'sealed-session');

renewal.resetRenewals();
let failedCalls = 0;
const failedRenewal = await renewal.renewOnce({
  sessionToken: 'session-token-2',
  cache: renewalCache,
  renew: async () => {
    failedCalls += 1;
    return null;
  },
});
const recoveredRenewal = await renewal.renewOnce({
  sessionToken: 'session-token-2',
  cache: renewalCache,
  renew: async () => {
    failedCalls += 1;
    return 'recovered';
  },
});
check(
  'a failed renewal is not cached',
  failedRenewal === null && recoveredRenewal === 'recovered',
  String(failedCalls),
);

renewal.resetRenewals();
let nullCached = 0;
const nullResult = await renewal.renewOnce({
  sessionToken: 'session-token-3',
  cache: renewalCache,
  renew: async () => {
    nullCached += 1;
    return null;
  },
});
check('a null renewal result is passed through', nullResult === null && nullCached === 1);

renewal.resetRenewals();
let triedTwice = 0;
await renewal.renewOnce({ sessionToken: 's4', cache: null, renew: async () => { triedTwice += 1; return null; } });
await renewal.renewOnce({ sessionToken: 's4', cache: null, renew: async () => { triedTwice += 1; return null; } });
check('without a cache each serial call retries once', triedTwice === 2, String(triedTwice));

/* ---------------- Shared: reference-route cache ---------------- */

const refcache = await bundle('src/shared/refcache.ts', 'refcache.mjs');

check('the cache-hit header is X-Bridge-Cache', refcache.REF_CACHE_HEADER === 'X-Bridge-Cache');

const refStore = fakeCache();
const refBase = {
  cache: refStore,
  ttlSeconds: 60,
  route: '/banks',
  scope: 'MERCHANT0001',
  request: { upstream: '/backend/api/bank/list', body: {} },
  cacheable: (r) => r.status >= 200 && r.status < 300,
};

let refRuns = 0;
const refRun = async () => {
  refRuns += 1;
  return { status: 200, data: ['a'] };
};

const refFirst = await refcache.withRefCache({ ...refBase, run: refRun });
check('a reference call runs upstream on a cold cache', !refFirst.hit && refRuns === 1, String(refRuns));

const refSecond = await refcache.withRefCache({ ...refBase, run: refRun });
check(
  'the next identical call is served from cache',
  refSecond.hit && refRuns === 1 && refSecond.result.data[0] === 'a',
  String(refRuns),
);

const refOtherMerchant = await refcache.withRefCache({ ...refBase, scope: 'MERCHANT0002', run: refRun });
check('another merchant never sees that entry', !refOtherMerchant.hit && refRuns === 2, String(refRuns));

const refOtherRequest = await refcache.withRefCache({
  ...refBase,
  request: { upstream: '/backend/api/bank/list', body: { page: 2 } },
  run: refRun,
});
check('a different request hashes to a different entry', !refOtherRequest.hit && refRuns === 3, String(refRuns));

let failRuns = 0;
const refFailing = {
  ...refBase,
  route: '/settlement',
  run: async () => {
    failRuns += 1;
    return { status: 500 };
  },
};
await refcache.withRefCache(refFailing);
await refcache.withRefCache(refFailing);
check('a failed response is never cached', failRuns === 2, String(failRuns));

let ttlRuns = 0;
const refNoTtl = {
  ...refBase,
  ttlSeconds: 0,
  route: '/no-ttl',
  run: async () => {
    ttlRuns += 1;
    return { status: 200 };
  },
};
await refcache.withRefCache(refNoTtl);
await refcache.withRefCache(refNoTtl);
check('a route without a TTL always calls upstream', ttlRuns === 2, String(ttlRuns));

let nullCacheRuns = 0;
const refNoCache = {
  ...refBase,
  cache: null,
  route: '/no-cache',
  run: async () => {
    nullCacheRuns += 1;
    return { status: 200 };
  },
};
await refcache.withRefCache(refNoCache);
await refcache.withRefCache(refNoCache);
check('without a cache every call goes upstream', nullCacheRuns === 2, String(nullCacheRuns));

let hostileRuns = 0;
const hostileRefCache = {
  match: async () => {
    throw new Error('no cache here');
  },
  put: async () => {
    throw new Error('no cache here');
  },
};
const refHostile = {
  ...refBase,
  cache: hostileRefCache,
  route: '/hostile',
  run: async () => {
    hostileRuns += 1;
    return { status: 200 };
  },
};
const hostileFirst = await refcache.withRefCache(refHostile);
const hostileSecond = await refcache.withRefCache(refHostile);
check(
  'a throwing cache still answers, just uncached',
  !hostileFirst.hit && !hostileSecond.hit && hostileRuns === 2,
  String(hostileRuns),
);

/* ---------------- Shared: two-layer rate limit ---------------- */

const ratelimit = await bundle('src/shared/ratelimit.ts', 'ratelimit.mjs');

ratelimit.resetRateLimit();
check(
  'the in-isolate counter trips on the fourth call of a limit of three',
  !ratelimit.isRateLimited('k', 3) &&
    !ratelimit.isRateLimited('k', 3) &&
    !ratelimit.isRateLimited('k', 3) &&
    ratelimit.isRateLimited('k', 3),
);

ratelimit.resetRateLimit();
check(
  'separate keys are counted separately',
  !ratelimit.isRateLimited('a', 1) && !ratelimit.isRateLimited('b', 1) && ratelimit.isRateLimited('a', 1),
);

const denyLimiter = { limit: async () => ({ success: false }) };
check(
  'the edge limiter denies when it says deny',
  (await ratelimit.checkRateLimit({ LOGIN_RATE_LIMITER: denyLimiter }, 'x', 10)) === true,
);

const allowLimiter = { limit: async () => ({ success: true }) };
ratelimit.resetRateLimit();
check(
  'the edge limiter allows when it says allow',
  (await ratelimit.checkRateLimit({ LOGIN_RATE_LIMITER: allowLimiter }, 'x', 1)) === false,
);

const brokenLimiter = {
  limit: async () => {
    throw new Error('binding unavailable');
  },
};
ratelimit.resetRateLimit();
check(
  'a broken limiter does not fail open',
  (await ratelimit.checkRateLimit({ LOGIN_RATE_LIMITER: brokenLimiter }, 'y', 1)) === false &&
    (await ratelimit.checkRateLimit({ LOGIN_RATE_LIMITER: brokenLimiter }, 'y', 1)) === true,
);

rmSync(outDir, { recursive: true, force: true });

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
