# payment-bridges

Two Cloudflare Workers that put a clean, CORS-friendly HTTP API in front of two
Nepali payment portals, so a website or app can read settlements, collections and
transactions — and mint QR codes — without ever touching a portal's internal
tokens.

```
   your site ──► nepalpay-bridge ──► business.nepalpay.com.np   /backend/api/*
             └─► fonepay-bridge   ──► corporate-kong.fonepay.com /corporate/api/*
```

Each bridge is an independent Worker with its own route table, its own bindings
and its own `SESSION_SECRET`. They share only the session crypto and HTTP
plumbing in `src/shared/`.

|  | [NepalPay](docs/nepalpay-bridge.md) | [Fonepay](docs/fonepay-bridge.md) |
| --- | --- | --- |
| Portal | `business.nepalpay.com.np` | `fonebiz.fonepay.com` |
| Upstream | `business.nepalpay.com.np/backend/api/*` | `corporate-kong.fonepay.com/corporate/{api,auth}/*` |
| Sign-in | one call, `POST auth/signin` | two calls: `email-lookup` → `corporate-login` |
| Access token | HS256 JWT | JWE (`A128GCMKW`, payload encrypted) |
| Envelope | `{code, status, message, data, errors}` | `{message, code:"0", isSuccess, data}` |
| Success status | `200` | `200` **and `202`** |
| Renewal | refresh-token endpoint | **none exists** — re-signs in |
| Edge | F5 ASM (fingerprint-sensitive) | no fingerprint filtering observed |
| Worker | `nepalpay-bridge` | `fonepay-bridge` |
| Config | `wrangler.jsonc` | `wrangler.fonepay.jsonc` |
| Console | `public/` | `public-fonepay/` |

## Quick start

```bash
npm install

# one secret per Worker, 32 random bytes as base64url
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

npx wrangler secret put SESSION_SECRET --config wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.fonepay.jsonc

npm run dev            # nepalpay-bridge  → http://127.0.0.1:8787
npm run dev:fonepay    # fonepay-bridge   → http://127.0.0.1:8788

npm run deploy         # nepalpay-bridge
npm run deploy:fonepay # fonepay-bridge
```

For local runs, copy `.dev.vars.example` to `.dev.vars` (and to
`.dev.vars.fonepay`) and paste the same key. Wrangler reads the file that matches
the config's Worker name.

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
| `GET /api` | The curated route table, as JSON |
| `GET /api/health` | Upstreams, renewal mode, whether the secret is set |

Each bridge also serves a test console: open the Worker's URL, sign in with a
merchant account, and every view is a real call through the bridge.

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
`401 SESSION_EXPIRED`, `429 RATE_LIMITED`, `409 OTP_REQUIRED`.

**Renewal is explicit about what it can do.** NepalPay has a refresh endpoint and
the bridge uses it. Fonepay issues a `refreshToken` that its own portal never
exchanges — there is no refresh route anywhere in the app bundle — so the Fonepay
bridge re-signs-in, which means the credentials live inside the sealed session.
Set `FONEPAY_RENEW_ON_EXPIRY=0` to turn that off and accept hourly sign-ins
instead.

## Verification

```bash
npm run typecheck     # tsc --noEmit
npm test              # 124 checks — session crypto, payload building, route tables
npm run test:e2e      #  32 checks — NepalPay Worker against a mock portal
npm run test:e2e:fonepay  # 69 checks — Fonepay Worker against a mock gateway
npm run test:all      # everything
```

The unit suite bundles the real modules with esbuild; the e2e suites load the
real Worker and drive it with `worker.fetch()` against a local mock, so sign-in,
identity injection, proactive renewal, recovery from an expired or
server-invalidated token, the OTP hand-off, scoping refusals and the CORS
preflight are all exercised without touching production.

## Security notes

* `ALLOWED_ORIGINS` is a CORS header, not an access control — it restrains
  browsers only. With it empty, any origin can call the bridge.
* `POST /api/auth/login` is a credential relay. Rate limiting is per-isolate and
  best-effort; put a WAF rate-limiting rule in front of it before this is public.
* The Fonepay bridge stores credentials inside the sealed session so it can
  re-sign-in. They are encrypted with `SESSION_SECRET` and never readable by the
  page, but they are recoverable by the Worker. Prefer `FONEPAY_RENEW_ON_EXPIRY=0`
  if that trade is not worth it.
* Rotate `SESSION_SECRET` to invalidate every outstanding session.

## Layout

```
src/
  shared/       session crypto (AES-GCM), CORS, error envelope, throttle, headers
  nepalpay/     client, route table, refresh, edge diagnostics, Worker app
  fonepay/      client, route table, Worker app (renew-by-re-sign-in)
public/         NepalPay console, drop-in client, embeddable QR page
public-fonepay/ Fonepay console (+ vendored MIT QR encoder)
test/           unit suite and both e2e suites
tools/          find-refresh — locate a token refresh call in any HAR
docs/           per-provider deep dives
```

Captured portal traffic (`.har`), local secrets (`.dev.vars*`) and the `.scratch/`
probe directory are gitignored and must stay that way: a HAR of a signed-in
portal session contains a working access token, a refresh token, session cookies
and often the password in cleartext.

## Credits

The console renders QR payloads with [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
by Kazuhiko Arase (MIT), vendored under `public-fonepay/vendor/`.
