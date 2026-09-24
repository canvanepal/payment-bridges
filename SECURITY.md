# Security

These Workers sit in front of real payment portals and hold real merchant
credentials. Treat an instance as production infrastructure.

## Reporting a vulnerability

Open a **private** GitHub security advisory on this repository
(`Security` → `Report a vulnerability`) rather than a public issue. Please include
the Worker URL or commit, what an attacker can do, and the smallest reproduction
you have. Expect an acknowledgement within a few days.

Do not test against someone else's deployment, and do not run scans against the
upstream portals — that is the bank's infrastructure, and unauthorised probing may
be a criminal offence under Nepali law.

## What is in the threat model

- **The bridge is a credential relay.** Anyone who can call `/api/auth/login`
  and holds a merchant's username and password gets a session that can read that
  merchant's transactions and mint QRs.
- **A session token is a bearer credential**, sealed with `SESSION_SECRET`. On the
  Fonepay bridge it additionally contains the account password, because Fonepay
  exposes no refresh endpoint and renewal re-signs-in.
- **`SESSION_SECRET` compromise is full compromise** of every session ever issued
  by that Worker, because sessions are stateless and carry no revocation list.
- **`BRIDGE_KEY` is the only caller authentication.** Unset means open.

## Deployment checklist

1. `BRIDGE_KEY` is set (`wrangler secret put BRIDGE_KEY`) and every site sends it.
2. `ALLOWED_ORIGINS` lists your own origins, not `*`.
3. `SESSION_SECRET` is 32 random bytes, base64url, unique per Worker:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
4. Rotate the merchant password if it has ever been in a HAR, a log, a chat
   message or this repository's history.
5. `LOGIN_RATE_LIMIT_PER_MINUTE` and the `ratelimits` binding are what stop an
   online guessing attempt; do not raise them without a reason.
6. Never serve a session token in a URL. The client and widgets pass it over
   `postMessage` or an `Authorization` header precisely so it stays out of
   history, referrers and access logs.

## What this project deliberately does not do

- It does not store sessions server-side, so **logout cannot revoke anything** —
  discarding the token is the whole mechanism.
- It does not verify upstream TLS beyond the platform's own validation, and it
  decodes JWT payloads without verifying signatures (they arrive over TLS from a
  host we chose; the signature adds nothing to that trust decision).
- It does not attempt to defeat the portals' bot-protection. If an upstream edge
  refuses the bridge, the honest fix is documented upstream credentials from the
  provider, not a fingerprint workaround.
