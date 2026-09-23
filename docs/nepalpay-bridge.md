# NepalPay bridge

> Part of the [payment-bridges](../README.md) repo. This file is the deep dive for the NepalPay Worker only — the front page covers both bridges.

A Cloudflare Worker that puts a clean, CORS-friendly API in front of the NepalPay
merchant portal (`business.nepalpay.com.np`). Your website posts a username and
password, gets back an opaque session token, and then talks to named endpoints —
without ever handling NepalPay's JWTs.

```
  your site  ──►  nepalpay-bridge (Worker)  ──►  business.nepalpay.com.np
                    holds SESSION_SECRET         /backend/api/*
                    injects merchantCode
                    injects userDetail
```

## ✅ Status: working — the block was our own headers

Verified live on 2026-09-24 against the real portal, from the deployed Worker:
sign-in, the data routes, and automatic token renewal all succeed.

**The edge was never filtering by IP or TLS fingerprint. It was reacting to a
browser-spoofing `User-Agent`.** A credential-free bisect of
`POST /backend/api/auth/signin` with an empty body:

| Request | Result |
| --- | --- |
| bare POST, no UA override | **`400` `application/json` — API reached** |
| + `User-Agent: Mozilla/5.0 … Firefox/156.0` | `200` `text/html` → F5 `Request Rejected` |
| + browser UA + `Accept-Language` | **`400` `application/json` — API reached** |
| + `Origin`/`Referer`, no browser UA | **`400` `application/json` — API reached** |
| + browser UA + `sec-ch-ua` / `sec-fetch` | `200` `text/html` → rejected |
| the header set we used to ship | rejected |

The portal's F5 ASM treats *a browser User-Agent on a connection whose TLS
fingerprint isn't that browser* as client spoofing, and rejects the request before
the API sees it. Ironically, the "look like the SPA" headers that seemed necessary
were the whole problem. The fix is to stop pretending — the `minimal` profile
sends only `Accept`, `Content-Type`, `Authorization` and `Cookie`.

That rejection is easy to misread, which is why the Worker keeps detecting it: the
edge answers **HTTP 200 with an HTML body**, and from Cloudflare's egress the same
request came back as a **`520`**. Both now report `502 UPSTREAM_BLOCKED` instead of
`401 AUTH_FAILED`, so a transport problem never masquerades as a wrong password.

### Header profiles

`NEPALPAY_HEADER_MODE` picks the fingerprint:

| Mode | Sends | Status |
| --- | --- | --- |
| `minimal` | `Accept`, `Content-Type`, auth only | **default, verified** |
| `product` | as above + `User-Agent: nepalpay-bridge/1.0` | verified |
| `curl` | as above + `User-Agent: curl/8.5.0` | verified |
| `browser` | browser UA + `Accept-Language` + `Origin`/`Referer` | **rejected — diagnostic control** |

To re-check from the Worker's own egress — the only vantage point that counts —
set a `DIAG_TOKEN` secret and call:

```bash
curl -H "Authorization: Bearer $DIAG_TOKEN" \
  https://nepalpay-bridge.aashmatimalsina275.workers.dev/api/diag/matrix
```

It runs every profile against the sign-in endpoint with an empty body and reports
which ones reach the API. The target path and body are hardcoded, and the route
404s while `DIAG_TOKEN` is unset.

### The refresh endpoint: found, not guessed

The capture contained no refresh call, so it came out of the portal's own Angular
bundles once requests stopped being rejected (`chunk-7LKYD5LY.js` holds the route
table, `chunk-KMQN7IZT.js` the auth service):

```js
LOGIN: "/api/auth/signin",
LOGIN_REFRESH_TOKEN: "/api/auth/refresh-token",
LOGOUT: "/api/auth/logout"
// refreshToken(t){ return this.http.post(LOGIN_REFRESH_TOKEN, { refreshToken: t }) }
```

Verified against the live API: `POST /backend/api/auth/refresh-token` with
`{"refreshToken": …}` returns `code: "000"`, a fresh 60-minute access token and a
rotated refresh token, and the new access token works on data routes. A garbage
refresh token gets `401 Session Expired`; a nonexistent path gets `404`.

Both settings are wired up in `wrangler.jsonc`, so sessions renew themselves:

```
NEPALPAY_REFRESH_PATH  = /backend/api/auth/refresh-token
NEPALPAY_REFRESH_STYLE = body
```

### One caveat about the origin's own headers

The portal's `Content-Security-Policy-Report-Only` response header contains raw
newlines, which is illegal in HTTP/1.1. Node's `fetch` (undici) refuses to parse
such a response at all — it throws `Invalid header value char` — while `curl` and
Cloudflare's runtime tolerate it. Worth knowing if you test the upstream from Node
and it fails despite the request being an obvious success.

## Why the Worker does the hard part

The upstream API requires more than a token on every call. Observed in a captured
session, **every** request body also has to carry the caller's identity:

```json
{
  "merchantCode": "MERCHANT0001",
  "fromDate": "2026-09-23",
  "userDetail": {
    "user": "admin_example",
    "identificationCode": "MERCHANT0001",
    "subIdentificationCode": "MERCHANT0001"
  }
}
```

That identity is already inside the JWT, so the Worker derives it from the session
and overwrites whatever the caller sent. Your frontend only sends business inputs:

```json
{ "fromDate": "2026-09-01", "toDate": "2026-09-23" }
```

This also closes a real gap: because upstream scopes data by the client-supplied
`merchantCode`, a client that could set that field freely would be able to read
another merchant's transactions. In this bridge, caller-supplied `merchantCode`
and `userDetail` are always discarded — covered by tests.

## Sessions are stateless and encrypted

There is no database and no KV namespace. `POST /api/auth/login` signs in
upstream, then seals `{ accessToken, refreshToken, cookies, identity }` into a
single AES-GCM token using `SESSION_SECRET` (WebCrypto, fresh 12-byte nonce per
seal). Your browser holds that sealed blob.

Consequences worth knowing:

- The real NepalPay access token never reaches the browser.
- Nothing is stored server-side, so there is no session store to operate and no
  KV eventual-consistency window that could 401 a user right after login.
- Tampering is detected by GCM authentication — a modified token is rejected, not
  silently misread.
- Because it is stateless, a session **cannot be revoked** before it expires.

## Automatic session renewal

Access tokens live 1 hour, refresh tokens 24 hours. The Worker renews
transparently and hands the client a fresh sealed session in the
`X-Session-Token` response header.

**The upstream refresh route is configurable rather than hardcoded.** It was
missing from the capture (two minutes of activity, so the SPA never needed it) and
was eventually read out of the portal's own bundle — see
[the refresh endpoint](#the-refresh-endpoint-found-not-guessed) above. Two settings
drive it:

| Setting | Value in this project |
| --- | --- |
| `NEPALPAY_REFRESH_PATH` | `/backend/api/auth/refresh-token` |
| `NEPALPAY_REFRESH_STYLE` | `body`; also `bearer`, `body_token`, `query`, or a list to probe |

- **Before expiry:** within 5 minutes of expiry a request triggers renewal. If
  renewal fails the request still proceeds on the current token.
- **After expiry:** renewal is attempted; on failure the client gets
  `401 SESSION_EXPIRED` and signs in again.
- **Explicitly:** `POST /api/auth/refresh` forces a renewal and reports which style
  worked — the fastest way to validate your config.

Response parsing stays tolerant even though the real shape is now known:
`data.accessToken`, `access_token`, a bare `token`, nested `data.data`, and
`result` wrappers are all accepted, along with `expiresIn` / `expires_in`. Expiry
comes from the new token's own `exp` claim whenever it is present, so a rotated
token with a shorter life is honoured.

### Finding refresh routes in a capture

```bash
npm run find-refresh -- capture.har
```

Analyzes a HAR offline, redacts secrets, and reports the refresh call, its request
body, whether an `Authorization` header was used, and any backend endpoints not yet
wired up. Useful when a portal changes. To capture the call:

1. Log in to the portal with DevTools → Network open.
2. Leave the tab open past the 1 hour access-token life, or navigate until the SPA
   reacts to a 401.
3. Save the requests as a HAR, then run the command above.

Then set `NEPALPAY_REFRESH_PATH`, deploy, and confirm with
`POST /api/auth/refresh`. (Note that if the portal's bundle is reachable, grepping
it for `refresh` is usually faster than waiting an hour for a capture.)

## Test console

The Worker ships a self-contained browser console at **`/`** (served from
`public/index.html` via the `assets` binding in `wrangler.jsonc`). It needs no
build step and no dependencies — open the deployed URL, or `http://127.0.0.1:8787`
during `npm run dev`.

It is a working merchant dashboard, not a curl wrapper:

| View | What it does |
| --- | --- |
| **Dashboard** | Balance cards from `settle-unsettle` (settled, unsettled, counts, last session, settlement date), recent transactions, settlement statistic |
| **QR & payments** | Dynamic QR for an amount (renders the returned PNG), store QR, terminal QR, and a *Check for payment* poll |
| **Transactions** | Date/store/terminal/network/payer/txn-id filters, paged table, per-response raw JSON |
| **Summary**, **Networks** | Daily rollups and the issuer-network reference list |
| **Refunds** | Refundable transactions plus the refund reason codes |
| **Settlements** | Settlement batches over a date range |
| **Stores** | Store list, click-through to terminals and per-store totals, QR shortcuts |
| **Users** | Merchant users and assignable roles |
| **Reference** | Acquirer banks (50), roles, refund reasons, dashboard images |
| **All endpoints** | Every route from `GET /api`, each with an editable default body and a Send button |
| **Session** | Identity, token countdown, renewal, request history |

Behaviour worth knowing:

- **Renewal is visible.** When a response carries `X-Session-Token` the console
  silently slides its stored token forward and labels that response `session renewed`.
- **Data is rendered by shape**, not per-endpoint schema: an array becomes a table,
  `{ result, pageable }` becomes a paged table, a `data:` URI becomes a QR image,
  and a double-wrapped envelope is unwrapped. Amounts are formatted as NPR.
- **Failures explain themselves.** `502 UPSTREAM_BLOCKED` says the credentials were
  never evaluated; `401 AUTH_FAILED` is flagged as a real credential problem; a 5xx
  gets a Retry button, because the portal intermittently returns 500 for reasons
  that have nothing to do with your token.
- **It refuses requests that would be misreported.** NepalPay answers a missing
  `storeLabel` with HTTP 500 `"Session Expired"`; the console guards the form
  instead of letting that look like a dead session, and warns past the 90-day
  report limit.
- **The WS channel is not proxied.** Dynamic QR returns a websocket URL for live
  payment confirmation; the bridge cannot proxy it, so the console uses
  *Check for payment* to poll recent transactions instead.

The session token is held in `sessionStorage` (or `localStorage` if you tick
*remember in this browser*); the password is never stored.

## Using it from a site or app

The Worker hosts a zero-dependency client and an embeddable QR page, so an
integration is a script tag rather than a hand-rolled fetch layer:

| Asset | Purpose |
| --- | --- |
| `/nepalpay.js` | Classic script; exposes `window.NepalPay` |
| `/nepalpay.mjs` | ESM entry point with named exports (browsers, Node 18+, bundlers) |
| `/pay` | Hosted "scan to pay this amount" page, embeddable in an iframe (`/pay.html` also works — it redirects here) |
| `/` | The merchant console |

### Browser

```html
<script src="https://nepalpay-bridge.aashmatimalsina275.workers.dev/nepalpay.js"></script>
<script>
  const np = NepalPay.createClient({ baseUrl: 'https://nepalpay-bridge.aashmatimalsina275.workers.dev' });

  await np.login('username', 'password');      // once per user session
  const balance = await np.balance();          // { settled, unsettled, total, session }
  const qr = await np.createQr({ amount: 250, storeLabel: 'Store1', remarks: 'counter sale' });
  document.querySelector('#qr').src = qr.qrString;   // ready-to-use data URI
</script>
```

### App / server

```js
import { createClient } from 'https://nepalpay-bridge.aashmatimalsina275.workers.dev/nepalpay.mjs';

const np = createClient({ baseUrl, session: process.env.NP_SESSION });
const { result } = await np.reports.transactions({ from: '2026-09-01', to: '2026-09-24' });
```

### Surface

```js
await np.login(user, pass)        // -> { session, user, expiresAt, autoRenew }
await np.me() / np.refresh() / np.logout()
np.setSession(s) / np.isAuthenticated() / np.secondsUntilExpiry()

await np.balance()                // -> { settled, settledCount, unsettled, unsettledCount, total, session }
await np.recentTransactions()
await np.settlementStatistic()
await np.dashboardImages()

await np.stores({ size: 50 })     // -> { result: [...], pageable }
await np.searchStores('Store1')
await np.storeSummary('Store1', 'Terminal1')
await np.terminals('Store1', '')

await np.createQr({ amount, storeLabel, terminal, remarks })
await np.storeQr('Store1')
await np.terminalQr('Store1', 'Terminal1')

await np.reports.transactions({ from, to, storeLabel, terminal, payerMobileNumber, nqrTxnId, issuerNetwork, page, size })
await np.reports.summary({ from, to, storeLabel, terminal, issuerNetwork })
await np.reports.refunds({ from, to, txnStatus, payerMobileNumber })
await np.reports.settlements({ from, to, issuerNetwork })
await np.reports.network()

await np.refunds.list({ from, to, nqrTxnId, payerMobileNumber })
await np.refunds.reasons()
await np.users.list({ username, mobileNumber })   / np.users.roles()
await np.banks()

await np.raw('POST', body)        // any route, full envelope
await np.try('/api/health', undefined, 'GET')      // never throws
```

`from` / `to` are local calendar dates (`YYYY-MM-DD`) and default to the last
seven days. The 90-day upstream limit is enforced client-side, so an over-wide
range throws before a round trip.

### Errors are typed

Non-2xx responses throw a `NepalPayError` carrying `code`, `status`, `path`,
`help`, `retryable`, and the raw `body`. `UPSTREAM_BLOCKED` is explicitly not an
`AUTH_FAILED`: the first means the request was filtered before the API saw it, so
your password was never checked.

```js
try {
  await np.login(user, pass);
} catch (error) {
  if (error.code === 'UPSTREAM_BLOCKED') // transport policy, not credentials
  if (error.retryable)                   // 5xx or unreachable — retry
}
```

### Embeddable QR widget

```html
<div id="pay"></div>
<script src="/nepalpay.js"></script>
<script>
  const np = NepalPay.createClient({ baseUrl: location.origin });
  const { session } = await np.login(user, pass);

  NepalPay.payWidget('#pay', {
    baseUrl: location.origin,
    session,
    amount: 250,
    storeLabel: 'Store1',
    onPaid: (payment) => console.log('paid', payment.transaction.instructionId),
  });
</script>
```

The widget is handed the session over `postMessage`, never in the URL, so the
token cannot leak into history, a referrer, or an access log. It generates the QR,
shows a live countdown, polls for the payment, and posts back:

| Message | Meaning |
| --- | --- |
| `ready` | Widget mounted; the host sends `{ type: 'session', session }` back |
| `qr` | QR created (`qrString`, `validationTraceId`) |
| `status` | Poll result, `{ paid: false }` while waiting |
| `renewed` | The bridge slid the session forward; store the new one |
| `paid` | Payment seen — includes the transaction row |
| `error` | `{ code, message, help }` |

The page also works standalone if you append the session as a fragment
(`/pay?amount=250&store=Store1#session=…`), which is never sent to a server.
Live confirmation needs the portal's websocket, which the bridge does not proxy, so
the widget polls recent transactions instead — typically within a few seconds.

### Which decisions to revisit before shipping

- **The bridge is open.** Anyone who knows the URL can relay a merchant login, and
  CORS only restrains browsers. Put a Cloudflare WAF rate-limit rule on
  `/api/auth/login`, or add a shared key, before this is public.
- **Sessions are bearer tokens.** Store them in memory (default) or
  `sessionStorage`; anywhere a third-party script runs, treat the token as exposed.
- **`pay.html` shows whatever amount you pass it.** Compute the amount server-side
  and sign it if a customer can influence it.

## Setup

```bash
npm install

# 1. Generate a session key (32 bytes, base64url)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 2. Store it as a Worker secret (production)
npx wrangler secret put SESSION_SECRET

# 3. Local development — put the same key in .dev.vars
cp .dev.vars.example .dev.vars   # then edit it

# 4. Run
npm run dev      # http://127.0.0.1:8787
npm test         # 85 unit checks, no network
npm run test:e2e # 32 checks against a local mock upstream
npm run typecheck
npm run deploy
```

### Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | secret | 32-byte key used to seal session tokens. Required. |
| `NEPALPAY_BASE_URL` | var | Upstream origin. Defaults to `https://business.nepalpay.com.np`. |
| `ALLOWED_ORIGINS` | var | Comma-separated CORS allowlist. **Empty means any origin** — see Security. |
| `NEPALPAY_REFRESH_PATH` | var | Upstream refresh route. Set to `/backend/api/auth/refresh-token`; empty disables renewal. |
| `NEPALPAY_REFRESH_STYLE` | var | How the refresh token is presented: `body` (`{refreshToken}`), `bearer`, `body_token`, `query`, or a list. |
| `NEPALPAY_HEADER_MODE` | var | Upstream header fingerprint: `minimal` (default), `product`, `curl`, `browser`. See [Header profiles](#header-profiles). |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | var | Per-isolate throttle on `/api/auth/login`. Default `10`. |
| `DIAG_TOKEN` | secret | Bearer token for `GET /api/diag/matrix`. Unset means the route 404s. |

## Endpoints

### Auth

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/auth/login` | `{ username, password }` | `{ session, expiresAt, expiresIn, user }` |
| `GET /api/auth/me` | — | Session identity and expiry, no secrets |
| `POST /api/auth/refresh` | — | Force a renewal; reports which style worked |
| `POST /api/auth/logout` | — | Acknowledgement; discard the token client-side |

### Data

All require `Authorization: Bearer <session>`. Identity fields are injected for you.

Paths and bodies come from the portal's own route table and request builders, so
these match what the merchant UI itself sends.

| Route | Body you send | Upstream call |
| --- | --- | --- |
| `POST /api/dashboard/balance` | — | `dashboard/transaction/settle-unsettle` |
| `POST /api/dashboard/transactions` | — | `dashboard/transaction/list` |
| `POST /api/dashboard/settlement` | — | `dashboard/transaction/settlement` |
| `GET /api/dashboard/images` | — | `dashboard/images` |
| `POST /api/stores` | `{ pageable? }` | `merchant/stores/list` |
| `POST /api/stores/search` | `{ storeLabel, pageable? }` | `merchant/stores/store-label` |
| `POST /api/stores/summary` | `{ storeLabel, terminal? }` | `merchant/stores/terminal/store-label-selected` |
| `POST /api/stores/terminals` | `{ storeLabel, terminal? }` | `merchant/stores/terminal/store-label` |
| `POST /api/qr` | `{ storeLabel, terminal?, amount, remarks? }` | `nqr/generate` |
| `POST /api/qr/store` | `{ storeLabel }` | `stores/nqr/generate` |
| `POST /api/qr/terminal` | `{ storeLabel, terminal }` | `stores/terminal/nqr/generate` |
| `POST /api/reports/transactions` | `{ fromDate, toDate, storeLabel?, terminal?, nqrTxnId?, payerMobileNumber?, issuerNetwork?, pageable? }` | `report/transaction/list` |
| `POST /api/reports/summary` | `{ fromDate, toDate, storeLabel?, terminal?, issuerNetwork?, pageable? }` | `report/summary/list` |
| `POST /api/reports/network` | — | `report/network/list` |
| `POST /api/reports/refunds` | `{ fromDate, toDate, txnStatus?, payerMobileNumber?, pageable? }` | `report/refund/list` |
| `POST /api/reports/settlements` | `{ fromDate, toDate, issuerNetwork?, pageable? }` | `report/settlement/list` |
| `POST /api/refunds` | `{ nqrTxnId?, payerMobileNumber?, fromDate, toDate, pageable? }` | `refund/transaction/list` |
| `GET /api/refunds/reasons` | — | `refund/reason` |
| `POST /api/users` | `{ username?, mobileNumber?, pageable? }` | `v1/users/list` |
| `GET /api/users/roles` | — | `v1/users/role` |
| `POST /api/banks` | — | `bank/list` |

`dashboard/balance` is the one that answers "how much is settled?" — it returns
`settleUnsettleTxnInfo` (amounts and counts) plus the last `sessionSrlInfo`.

Responses are passed through in NepalPay's own envelope
(`{ code, status, message, timeStamp, data, errors }`), and the upstream HTTP
status is mirrored. Adding another endpoint is a single entry in `POST_ROUTES`
in `src/routes.ts`.

Three endpoints are reference lookups rather than merchant data, so `identity:
'none'` stops the Worker injecting `merchantCode`/`userDetail` into them:
`bank/list`, `refund/reason`, and `v1/users/role`.

`GET /api` lists all of the above with their upstream paths, titles, and default
bodies — which is what the console's *All endpoints* view is built from.

### Diagnostics

| Route | Needs | Returns |
| --- | --- | --- |
| `GET /api/health` | — | Upstream URL, whether the secret is set, renewal config, header mode |
| `GET /api` | — | Route listing and renewal contract |
| `GET /api/diag/matrix` | `DIAG_TOKEN` | Each header profile tried from this Worker's egress, and which reached the API |

## Frontend usage

```js
const API = 'https://nepalpay-bridge.aashmatimalsina275.workers.dev';

let session = null; // keep in memory, or sessionStorage

// The Worker renews transparently; the fresh token arrives on every response
// that triggered a renewal. Storing it is all the client has to do.
function absorbRenewal(res) {
  const renewed = res.headers.get('X-Session-Token');
  if (renewed) session = renewed;
}

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error((await res.json()).message);
  session = (await res.json()).data.session;
  return session;
}

// merchantCode and userDetail are injected by the Worker
async function transactions(fromDate, toDate) {
  const res = await fetch(`${API}/api/reports/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify({ fromDate, toDate }),
  });
  absorbRenewal(res);
  if (res.status === 401) throw new Error('SESSION_EXPIRED'); // send the user back to login
  return (await res.json()).data;
}
```

## Security

Read this before deploying.

**The Worker is an open relay by design.** With `ALLOWED_ORIGINS` empty, any
origin can call it, and `POST /api/auth/login` will forward credentials upstream.
Anyone who learns the URL can use your Worker as a login relay against NepalPay
from Cloudflare's IP space. `ALLOWED_ORIGINS` only restrains browsers (it is a
CORS header, not a server-side check), so it is not a real gate. Before this faces
the public internet, pick one:

- Put the Worker behind Cloudflare Access, or require a shared secret header and
  verify it server-side.
- Add a Cloudflare WAF rate-limiting rule on `/api/auth/login`. The built-in
  throttle is per-isolate and best-effort only — it does not coordinate globally.

**Credentials.** The password is forwarded to NepalPay in the request body over
TLS and is never stored, logged, or written into the session token. Only the
access token, refresh token, and edge cookies are sealed inside it.

**Rotate the leaked password.** The HAR this was built from contains the account
password, a live access token, a 24-hour refresh token, and session cookies in
cleartext. Treat all of them as compromised and change the password.

**Session lifetime.** Renewal is on, so an active client slides forward
indefinitely: within five minutes of expiry the Worker refreshes upstream and
returns a fresh sealed session on `X-Session-Token`. A client that goes quiet for
24 hours — the refresh token's life — must sign in again. Turning renewal off
(`NEPALPAY_REFRESH_PATH` empty) makes sessions end after about an hour.

## Known limitations

- Only endpoints observed in the captured session are exposed.
- `dashboard/transaction/settlement` returned HTTP 400 on every attempt upstream;
  the Worker surfaces that faithfully rather than hiding it.
- Sign-in cookies are captured and replayed. The edge does not appear to pin
  sessions to an IP — successful calls have come from both a residential address
  and Cloudflare's egress — but that is a sample of two, so watch the logs.
- This drives the portal's private web API, which is undocumented and can change
  without notice. NCHL offer a proper merchant API with IP allowlisting; migrating
  to it is the durable answer for anything payment-critical.
- Nothing is cached — every request hits NepalPay and counts against its limits.
- **Reports cap at 90 days.** Passing a wider range returns
  `001 Date range should not exceed 90 days`, so page through windows instead.
- **A missing `storeLabel` looks like an auth failure.** The portal answers with
  HTTP 500 and the message `"Session Expired"`; several other missing-parameter
  cases do the same. Read it as a bad request. The console guards for it.
- **Transient 5xx happens.** Occasional upstream 500s clear on retry. The console
  offers a Retry button instead of implying your token is dead.
- **Live payment confirmation needs a websocket** to `ws.nepalpay.com.np`, which
  the bridge cannot proxy. Dynamic QR still generates; confirmation has to be
  polled (the console's *Check for payment* does this against recent transactions).
- **Writes are not exposed.** Store/terminal create-update and the refund
  maker/checker flow are deliberately absent — the bridge is read-only plus QR, so
  a token leak cannot move money.
- **Node's `fetch` cannot read the portal's responses** (see the CSP header note
  above); use `curl` or the Worker when testing upstream by hand.

## Layout

```
src/index.ts             Hono app: middleware, auth, renewal, route wiring
src/routes.ts            Curated route table + identity injection (pure, tested)
src/refresh.ts           Configurable token refresh + tolerant parsing (pure, tested)
src/nepalpay.ts          Upstream client: headers, cookie jar, JWT decode
src/session.ts           AES-GCM sealing/unsealing (pure, tested)
src/headers.ts           Upstream header profiles (pure, tested)
src/diag.ts              Header-profile probe, run from the Worker's egress
src/types.ts             Shared types
public/index.html        Merchant dashboard console, served at /
public/nepalpay.js       Client SDK (script tag / global)
public/nepalpay.mjs      Client SDK ESM entry point
public/pay.html          Embeddable "scan to pay" QR page
public/favicon.svg       Brand mark
test/run.mjs             85 unit checks, no network
test/e2e.mjs             32 checks: full flow against a mock upstream
tools/find-refresh.mjs   Locates the refresh call in a captured HAR
```
