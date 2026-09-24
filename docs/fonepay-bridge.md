# Fonepay bridge

> Part of the [payment-bridges](../README.md) repo. This file is the deep dive for
> the Fonepay Worker only — the front page covers both bridges.

A Cloudflare Worker in front of the Fonepay corporate portal
(`fonebiz.fonepay.com`, API at `corporate-kong.fonepay.com`). Your site posts a
username and password, gets back an opaque session token, and then reads
collections, settlements and the merchant hierarchy, or mints Fonepay QR codes.

```
  your site ──► fonepay-bridge ──► corporate-kong.fonepay.com
                 holds SESSION_SECRET   /corporate/auth/*   (sign-in)
                 scopes merchantId      /corporate/api/*    (data)
```

## Where the API surface came from

Nothing here was guessed. Two sources:

1. **A captured portal session** — 155 requests over ~12 minutes, which is where
   the envelope shapes, the `202` success status and the real request bodies came
   from.
2. **The portal's own Angular bundle**, fetched from the origin and read for its
   endpoint constants:

   ```js
   ENDPOINT:     "https://corporate-kong.fonepay.com/corporate/api",
   AUTH_ENDPOINT:"https://corporate-kong.fonepay.com/corporate/auth",
   LOGIN:                     "authentication/corporate-login",
   VALIDATE_LOGIN_OTP:        "authentication/validateLoginWithOtpCode",
   EMAIL_LOOKUP:              "authentication/email-lookup",
   ```

   The capture contained no sign-in — it began after the session was already
   established — so the bundle is what made the login flow knowable at all.

## Sign-in is two steps

```js
emailLookup(e) { return this.http.post(AUTH_ENDPOINT + "/" + EMAIL_LOOKUP, e) }
login(e)       { return this.http.post(AUTH_ENDPOINT + "/" + LOGIN, e) }
```

```jsonc
// 1. identifier → corporate accounts
POST /corporate/auth/authentication/email-lookup
     { "emailOrUsername": "…", "clientCode": "CORPORATE_USER" }
→    { "emailExists": true, "requiresCorporateSelection": false,
       "corporateOptions": [{ "corporateCode": "…" }] }

// 2. the sign-in itself
POST /corporate/auth/authentication/corporate-login
     { "emailOrUsername": "…", "password": "…",
       "clientCode": "CORPORATE_USER", "corporateCode": "…" }
→    { "accessToken": "<JWE>", "refreshToken": "…", "expireTime": …,
       "tokenCreatedDate": …, "userId": …, "username": …,
       "navigationRoleResponse": […], "otpType": "…" }
```

`POST /api/auth/login` runs both. Pass `corporateCode` and it skips the lookup;
leave it out and the bridge resolves it. If the identifier maps to more than one
corporate the bridge answers `409 CORPORATE_SELECTION_REQUIRED` with the options
rather than guessing.

Send the credentials with no `Accept`-driven tricks: unlike NepalPay's edge, the
Fonepay gateway does not filter on client fingerprint. It does expect the
portal's own `Origin`/`Referer`, which the bridge sends by default and which
`FONEPAY_ORIGIN` overrides.

## There is no refresh endpoint

This is the finding that shaped the bridge.

* `business.nepalpay.com.np` has `POST /backend/api/auth/refresh-token`.
* Fonepay **does not**. The whole bundle was downloaded and searched: the only
  `authentication/*` routes are `corporate-login`, `validateLoginWithOtpCode` and
  `email-lookup`. `refreshToken` is written to `sessionStorage` and never spent.
  A config constant `REFRESH_TOKEN_TRIGGER_PERCENTAGE: 80` hints at an intent
  that never shipped.

So the bridge renews by **signing in again**, which means the credentials are kept
inside the sealed session. Two consequences worth stating plainly:

* The session token is encrypted with `SESSION_SECRET` and is unreadable by the
  page, but the Worker can recover the password from it.
* `FONEPAY_RENEW_ON_EXPIRY=0` disables it. Sessions then end when the token does
  and the caller signs in again.

Renewal happens three ways, covering the cases a local clock cannot see:

1. **Proactively**, when the token is within 60 s of its inferred expiry.
2. **On a 401 from the gateway**, once, then the call is retried — this catches a
   token the server invalidated early, which no client-side timer can predict.
3. **On a 401 at sign-in-again**, `/api/auth/refresh` — so you can prove the
   stored credentials still work.

### Inferring expiry from an encrypted token

`expireTime` is the only expiry signal, and its unit is not documented. The
access token is a JWE, so its own `exp` claim is encrypted and unreadable. The
bridge disambiguates by magnitude:

| `expireTime` | Read as |
| --- | --- |
| `> 1e12` | epoch milliseconds |
| `> 1e9` | epoch seconds |
| `30 … 1e9` | a duration in seconds |
| `1000 … 1e9` (small) | milliseconds from now |
| anything else | a **4-minute** fallback |

A sub-30-second duration is deliberately rejected as implausible — the fallback
re-signs in early rather than handing the caller a token that is already dead.

## Routes

`GET /api` returns this table from the Worker itself.

| Bridge route | Upstream | Notes |
| --- | --- | --- |
| `GET /api/merchants` | `/corporate/api/v1/merchant-collection/linked-merchants` | merchants you can collect for |
| `GET /api/merchants/access` | `…/access/my-merchants` | merchants you were granted access to |
| `GET /api/merchants/pending-count` | `…/access/pending-count` | pending approvals |
| `GET /api/merchants/hierarchy` | `…/linked-merchants/{merchantId}/hierarchy` | sub-merchants and terminals |
| `POST /api/merchants/access-list` | `…/access/merchant/{merchantId}` | who can see a merchant |
| `POST /api/transactions` | `…/collections/transactions/filtered` | `page`, `size`, `from`/`to` in the query |
| `POST /api/transactions/summary` | `…/collections/transactions/summary` | the dashboard figure |
| `GET /api/transactions/hierarchy` | `…/collections/transactions/my-hierarchy` | the portal's own filter tree |
| `GET /api/transactions/detail` | `…/collections/transactions/{transactionId}` | one transaction |
| `POST /api/transactions/pending` | `/corporate/api/api/v1/transaction/transaction-pending-approval-list` | awaiting approval |
| `POST /api/settlements` | `…/merchant-collection/settlements` | `pageNumber`, `pageSize`, date range |
| `POST /api/qr/static` | `…/linked-merchants/{merchantId}/qr/generate` | per terminal |
| `POST /api/qr/dynamic` | `…/linked-merchants/{merchantId}/qr/dynamic` | amount-bound |
| `GET /api/profile` | `/corporate/api/profile/fetch-user-profile-details` | signed-in user |
| `POST /api/users` | `/corporate/api/user/active-corporate-user-list` | corporate users |
| `POST /api/reports/transactions` | `/corporate/api/api/v1/transaction/report-list` | report list |

Note the doubled prefix on the last three: the older transaction helpers really do
live under `/corporate/api/api/v1/…`. That is the gateway's layout, not a typo.

### Parameters

Callers send business inputs only:

* `merchantId` defaults to the first merchant linked to the session. Pass another
  and the bridge checks it against the list it read at sign-in — unlinked ids are
  refused with `400 INVALID_REQUEST`, so a caller cannot read a merchant the
  account was never linked to. If that list could not be read at sign-in the
  check is skipped rather than locking you out; the gateway still authorises.
* Query parameters (`page`, `size`, `fromTransmissionDateTime`, …) come from the
  request body under the same names; anything the caller sends beats the route
  default.
* Path placeholders (`{merchantId}`, `{transactionId}`) are filled from the body
  or the session, and a missing one is refused rather than silently rewritten.

## Response shapes are passed through

Fonepay's envelopes are inconsistent, so the bridge does not try to normalise
them:

* most endpoints: `{ message, code, isSuccess, data }`
* `profile/fetch-user-profile-details`: a bare object
* `user/active-corporate-user-list`: a bare array
* success is **HTTP 202** for reads, including QR generation

Whatever came back goes out unchanged, with the upstream status code, so callers
see exactly what Fonepay said. Only failures are re-wrapped, as
`{ code, status:"FAILED", message, timeStamp, data, errors }`.

## Console

`public-fonepay/` is served by the Worker: sign in with a merchant account and
every view is a real call through the bridge — overview, transactions with the
portal's own filter tree, settlements, QR, hierarchy, users, and a session panel
with forced renewal.

Fonepay returns the EMV payload itself (`qrString` / `qrMessage`) rather than an
image, so the console renders it in the browser with a vendored copy of
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). The
payload never leaves the page.

## Accounts the bridge cannot drive

* **`firstLogin` / `passwordExpired`** → `409 PASSWORD_CHANGE_REQUIRED`. Fonepay
  wants the password changed in its own portal before anything else works.
* **An OTP step** → `409 OTP_REQUIRED` plus a sealed `pendingSession`. Then
  `POST /api/auth/otp` with `{ session, otpCode }` finishes the sign-in; the
  temporary token authorises that call. The gateway's OTP body schema is not
  published, so the caller's fields are forwarded as sent.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FONEPAY_API_BASE_URL` | `https://corporate-kong.fonepay.com/corporate/api` | data API root |
| `FONEPAY_AUTH_BASE_URL` | `https://corporate-kong.fonepay.com/corporate/auth` | sign-in root |
| `FONEPAY_ORIGIN` | `https://fonebiz.fonepay.com` | `Origin`/`Referer` sent upstream |
| `FONEPAY_CLIENT_CODE` | `CORPORATE_USER` | OAuth client id the portal sends |
| `FONEPAY_USER_AGENT` | `fonepay-bridge/1.0` | honest UA; no spoofing needed |
| `FONEPAY_RENEW_ON_EXPIRY` | `1` | `0` disables renew-by-re-sign-in |
| `ALLOWED_ORIGINS` | empty | CORS allowlist; empty means any origin |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | `10` | per-isolate sign-in throttle |
| `DEBUG_UPSTREAM` | `0` | `1` logs one line per upstream call to `wrangler tail` |
| `SESSION_SECRET` | — | 32 bytes base64url, set with `wrangler secret put` |

Deploy with `npm run deploy:fonepay`, develop with `npm run dev:fonepay`.

## Verification

`npm run test:e2e:fonepay` drives the real Worker against a local mock gateway —
**102 checks**, including: sign-in with and without a corporate code, multiple
corporate accounts, `firstLogin`, the OTP hand-off, opaque auth failures, the
`202` pass-through, merchant scoping refusal, proactive renewal, recovery from an
expired token, recovery from a token the *server* invalidated, failing closed when
renewal is off, the throttle, the CORS preflight, and the account-scoped cache
answering a reference route a second time as `X-Bridge-Cache: HIT` with no
further gateway call.

`npm test` adds unit coverage for `expireTime` interpretation, login-response
parsing, the linked-merchant shape and the request builder.

The unit tests listed above never touch the real gateway. The only live calls made
while building this were credential-free: fetching the portal's static bundle, and
a single `email-lookup`/`corporate-login` pair with a deliberately nonexistent
identifier, which the gateway answered with
`{"emailExists":false}` and a `401 {"message":"User not found"}`.
