# payment-bridges

Two Cloudflare Workers that put a clean, CORS-friendly HTTP API in front of two
Nepali payment portals, so a website or app can read settlements, collections and
transactions — mint QR codes, and **know when a payment lands** — without ever
touching a portal's internal tokens.

```
   your site ──► nepalpay-bridge ──► business.nepalpay.com.np   /backend/api/*
             └─► fonepay-bridge   ──► corporate-kong.fonepay.com /corporate/api/*
```

Each bridge is an independent Worker with its own route table, its own bindings
and its own `SESSION_SECRET`. They share only the plumbing in `src/shared/`.

|  | [NepalPay](docs/nepalpay-bridge.md) | [Fonepay](docs/fonepay-bridge.md) |
| --- | --- | --- |
| Portal | `business.nepalpay.com.np` | `fonebiz.fonepay.com` |
| Upstream | `business.nepalpay.com.np/backend/api/*` | `corporate-kong.fonepay.com/corporate/{api,auth}/*` |
| Sign-in | one call, `POST auth/signin` | two calls: `email-lookup` → `corporate-login` |
| Access token | HS256 JWT | JWE (`A128GCMKW`, payload encrypted) |
| Envelope | `{code, status, message, data, errors}` | `{message, code:"0", isSuccess, data}` |
| Success status | `200` | `200` **and `202`** |
| Renewal | refresh-token endpoint | **none exists** — re-signs in |
| Payment match key | `validationTraceId` | the QR `remarks` |
| Edge | F5 ASM (fingerprint-sensitive) | no fingerprint filtering observed |
| Worker | `nepalpay-bridge` | `fonepay-bridge` |
| Config | `wrangler.jsonc` | `wrangler.fonepay.jsonc` |
| Console | `public/` | `public-fonepay/` |

## Deployed

Both Workers are live on Cloudflare's `workers.dev` subdomain. A site or app does
not need any of this repository — it only needs the base URL:

| Worker | Base URL |
| --- | --- |
| `nepalpay-bridge` | `https://nepalpay-bridge.aashmatimalsina275.workers.dev` |
| `fonepay-bridge` | `https://fonepay-bridge.aashmatimalsina275.workers.dev` |

Both are **closed**: they set `BRIDGE_KEY`, so every `/api/*` call needs the
shared secret in an `X-Bridge-Key` header. Unset `BRIDGE_KEY` on your own copy
while wiring a site up and the bridge answers anyone.

```js
const API = 'https://fonepay-bridge.aashmatimalsina275.workers.dev';
const KEY = process.env.BRIDGE_KEY;          // never in client-side code

const { data } = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': KEY },
  body: JSON.stringify({ emailOrUsername, password }),
}).then((r) => r.json());
```

> A bridge key in a browser bundle is not a secret — it is shipped to every
> visitor. Keep it server-side, or accept that the key only stops strangers, not
> your own users. See [Security notes](#security-notes).

**Verified live** through Cloudflare's egress: NepalPay signs in, lists stores,
reads transactions, renews its token, and mints a tracked QR; Fonepay runs the
corporate lookup and reaches the gateway (answered `401` for a deliberately
nonexistent identifier). NepalPay's edge needed a header fix before it would talk
to a Worker at all; Fonepay's did not.

## Quick start

```bash
npm install

# one secret per Worker, 32 random bytes as base64url
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

npx wrangler secret put SESSION_SECRET --config wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.fonepay.jsonc
npx wrangler secret put BRIDGE_KEY     --config wrangler.jsonc      # optional
npx wrangler secret put BRIDGE_KEY     --config wrangler.fonepay.jsonc

npm run dev            # nepalpay-bridge  → http://127.0.0.1:8787
npm run dev:fonepay    # fonepay-bridge   → http://127.0.0.1:8788

npm run deploy         # nepalpay-bridge
npm run deploy:fonepay # fonepay-bridge
```

For local runs, copy `.dev.vars.example` to `.dev.vars` (and to
`.dev.vars.fonepay`) and paste the same values. Wrangler reads the file that
matches the config's Worker name.

## Taking a payment

This is the part that makes a bridge usable for checkout rather than for
reporting. A QR on its own tells you nothing; a **collect** is a QR the bridge can
recognise later.

```
POST /api/collect        { amount, remarks?, orderId?, expiresInSeconds? }
     → { collectId, qrString, statusPath, expiresAt, keys, realtime }

GET  /api/collect/:id    → { state: "PENDING" | "PAID" | "EXPIRED", transaction? }
```

The handle returned is sealed with `SESSION_SECRET`, so a caller cannot edit what
it is waiting for, and the status call is scoped to the signed-in merchant.

```bash
QR=$(curl -sX POST "$BRIDGE/api/collect" -H "Authorization: Bearer $SESSION" \
       -H "X-Bridge-Key: $KEY" -H 'Content-Type: application/json' \
       -d '{"amount":250,"remarks":"Order 1042"}')

# statusPath is in the response; poll it until state is PAID
curl -s "$BRIDGE$(echo "$QR" | jq -r .data.statusPath)" -H "Authorization: Bearer $SESSION"
```

**How the match is made.** NepalPay returns a `validationTraceId` with every
dynamic QR and its own transaction records carry that same field, so that id is
the primary key. Fonepay's collection report has no order-id column, so the
bridge always writes a unique `remarks` value (`Bridge collect <id>`) when you do
not supply one; two identical amounts would otherwise be indistinguishable. Each
match then falls back, in order, to a value scan across the record (both portals
ship undocumented fields) and finally to amount plus a time window. Every verdict
reports `matchedBy`, so a surprising result is diagnosable rather than mysterious.

**Polling is cheap on purpose.** A PENDING verdict is cached for three seconds and
a PAID one for five minutes, so five watchers of one QR do not each scan the
merchant's transactions — and a settled payment never un-settles.

**The live sockets are passed through, not proxied.** Both portals hand back a
websocket for instant notifications (NepalPay a STOMP URL plus a
notification-scoped token, Fonepay a `websocketId`). A request-scoped Worker
cannot hold one, and the bridge will not ship your upstream token to a browser to
let it try, so `realtime` in the collect response is there for callers that have
their own reason to use it.

## Using a bridge

Both bridges speak the same shape:

```bash
# 1. exchange credentials for an opaque session token
curl -sX POST "$BRIDGE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"emailOrUsername":"you@example.com","password":"secret"}'

# 2. call named endpoints with it
curl -sX POST "$BRIDGE/api/transactions" \
  -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -d '{"fromTransmissionDateTime":"2026-09-01","toTransmissionDateTime":"2026-09-24"}'
```

The session token is an AES-GCM sealed blob. The portal's own access token never
reaches the browser, and there is no session database: nothing to operate, and no
KV consistency window that could 401 a user right after signing in.

When a request triggers renewal the Worker returns the fresh session in an
`X-Session-Token` response header. Store it and use it next time; that is all the
client has to do.

| Route | Purpose |
| --- | --- |
| `POST /api/auth/login` | Exchange credentials for a session |
| `POST /api/auth/lookup` | Fonepay only: which corporates an identifier belongs to |
| `POST /api/auth/otp` | Fonepay only: finish a sign-in that needs a one-time code |
| `GET /api/auth/me` | Session identity (no token material) |
| `POST /api/auth/refresh` | Force renewal, to prove the stored credentials still work |
| `POST /api/auth/logout` | Discard client-side; sessions are stateless |
| `POST /api/collect` | Mint a tracked QR for an amount |
| `GET /api/collect/:id` | Has it been paid? `PENDING` / `PAID` / `EXPIRED` |
| `GET /api` | The curated route table, as JSON |
| `GET /api/health` | Upstreams, renewal mode, security posture |
| everything else | The provider's own curated routes — see `GET /api` |

### Drop-in clients

Each console directory ships a zero-dependency client, usable from a `<script>`
tag, a bundler, or Node 18+:

```html
<script src="https://nepalpay-bridge.aashmatimalsina275.workers.dev/nepalpay.js"></script>
<script>
  const np = NepalPay.createClient({ baseUrl: 'https://…', bridgeKey: '…' });
  await np.login(username, password);
  const qr = await np.collect(250, { remarks: 'Order 1042' });
  document.querySelector('#qr').src = qr.qrString;
  const paid = await np.waitForPaid(qr);      // resolves when the money lands
</script>
```

`fonepay.js` is the same shape, plus the two things Fonepay needs: a sign-in that
can stop at a one-time code (`submitOtp`) or a corporate choice
(`corporateOptions`), and a QR that is an EMV payload rather than an image.

### Embeddable payment widget

`pay.html` (served by each Worker at `/pay`) renders a QR, waits for the payment
and reports it:

```js
const widget = NepalPay.payWidget('#pay', {
  baseUrl: 'https://nepalpay-bridge.aashmatimalsina275.workers.dev',
  amount: 250,
  remarks: 'Order 1042',
  session,                       // handed to the iframe over postMessage
  bridgeKey: '…',
  onPaid: (payment) => console.log('paid', payment),
});
```

The session and the bridge key travel to the iframe by `postMessage`, never in a
URL — so neither ends up in browser history, a referrer or an access log.

## The design worth knowing

**Identity comes from the session, never from the caller.** Both portals take
tenant identifiers in the request *body* — NepalPay wants `merchantCode` plus a
`userDetail` block, Fonepay wants a `merchantId` in the path or body. The bridge
derives them from the signed-in session and overwrites whatever the caller sent,
so a caller cannot widen scope to another merchant. Fonepay additionally checks
any `merchantId` against the linked merchants it read at sign-in and refuses
unlinked ones with `400 INVALID_REQUEST`.

**Errors name the real cause.** A wrong password and a refused connection are
different problems with different fixes, so they get different codes: `401
AUTH_FAILED`, `502 UPSTREAM_BLOCKED` (NepalPay's edge), `502 UPSTREAM_FAILED`,
`401 SESSION_EXPIRED`, `429 RATE_LIMITED`, `409 OTP_REQUIRED`,
`401 BRIDGE_KEY_REQUIRED`.

**Renewal is de-duplicated.** Sessions are stateless, so nothing inherently stops
twenty concurrent requests that notice the same near-expiry token from performing
twenty renewals — and on Fonepay every one of those is a real sign-in with the
stored password. An in-isolate map plus a 30-second cache entry collapses a burst
into a single upstream call, and `style: "shared"` tells you when a renewal was
reused rather than performed.

**Reference data is reused, not re-fetched.** Bank lists, refund reasons, role
names and Fonepay's filter tree change rarely, yet a portal re-reads them on
every screen. Routes marked `cacheSeconds` answer from the Cache API for 15
minutes under a key built from the account scope plus the built request — both
hashed — so callers of one merchant share a single upstream call while another
merchant's request hashes to a different entry and never sees it. Failures are
never stored, and a served answer carries `X-Bridge-Cache: HIT`.

**Timestamps are read in Nepal time.** Both portals report local wall-clock
strings with no offset. Read literally on a Worker (which runs in UTC) a fresh
payment looks almost six hours old, which is long enough to fall outside the
matching window — so bare local strings are pinned to `+05:45`.

## Verification

```bash
npm run typecheck          # tsc --noEmit
npm test                   # 210 checks — crypto, clients, matching, cache, throttle
npm run test:e2e           #  67 checks — NepalPay Worker against a mock portal
npm run test:e2e:fonepay   # 102 checks — Fonepay Worker against a mock gateway
npm run test:all           # everything (CI runs exactly this, plus a dry-run build)
```

The unit suite bundles the real modules with esbuild; the e2e suites load the real
Worker and drive it with `worker.fetch()` against a local mock. Between them they
cover sign-in, identity injection, proactive renewal, recovery from an expired or
server-invalidated token, the OTP hand-off, scope refusals, the CORS preflight,
bridge-key enforcement, a full collect (mint → PENDING → PAID by correlation key),
expiry, provider mismatch, **five parallel requests triggering exactly one
renewal** on each bridge, and a reference route going upstream once, then
answering `X-Bridge-Cache: HIT` without a second upstream call.

## Security notes

* **Set `BRIDGE_KEY`.** Without it the bridge answers anyone who knows the URL,
  and it is a credential relay into a payment portal. With it, every `/api/*` call
  needs the secret. This is caller authentication — it is not a substitute for
  TLS, and it does not stop a determined attacker who has the key.
* `ALLOWED_ORIGINS` is a CORS header, not an access control — it restrains
  browsers only.
* `POST /api/auth/login` is rate-limited at the edge (`ratelimits` in the wrangler
  config, 10/minute) and again per isolate. Raise the binding before raising the
  ceiling in front of a busy public page.
* The Fonepay bridge stores credentials inside the sealed session so it can
  re-sign-in. They are encrypted with `SESSION_SECRET` and never readable by the
  page, but they are recoverable by the Worker. Prefer `FONEPAY_RENEW_ON_EXPIRY=0`
  if that trade is not worth it.
* Rotate `SESSION_SECRET` to invalidate every outstanding session — there is no
  revocation list, because there are no server-side sessions.
* `SECURITY.md` has the threat model, the deployment checklist and how to report a
  problem. Read it before pointing anything real at these.

## Layout

```
src/
  shared/       session crypto, tokens, collect primitives, cache, throttle, CORS
  nepalpay/     client, route table, refresh, collect, edge diagnostics, Worker app
  fonepay/      client, route table, collect, Worker app (renew-by-re-sign-in)
public/         NepalPay console, drop-in client, embeddable pay page
public-fonepay/ Fonepay console, drop-in client, embeddable pay page, QR encoder
test/           unit suite and both e2e suites
tools/          find-refresh — locate a token refresh call in any HAR
docs/           per-provider deep dives
```

Captured portal traffic (`.har`), local secrets (`.dev.vars*`) and the `.scratch/`
probe directory are gitignored and must stay that way: a HAR of a signed-in
portal session contains a working access token, a refresh token, session cookies
and often the password in cleartext.

## License

MIT (see `LICENSE`). The Fonepay widget renders QR payloads with a vendored copy
of [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) —
see `NOTICE`.
