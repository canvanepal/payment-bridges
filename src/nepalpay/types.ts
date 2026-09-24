import type { RateLimiterBinding } from '../shared/ratelimit';

/** Bindings available to the Worker at runtime. */
export interface Env {
  /** Upstream NepalPay origin, e.g. https://business.nepalpay.com.np */
  NEPALPAY_BASE_URL?: string;
  /** base64url-encoded 32-byte key used to seal/unseal session tokens. Set with `wrangler secret put`. */
  SESSION_SECRET: string;
  /**
   * Upstream path that exchanges a refresh token for a new access token, e.g.
   * `/backend/api/auth/refresh`. When unset, sessions simply end after ~1 hour.
   */
  NEPALPAY_REFRESH_PATH?: string;
  /**
   * How to present the refresh token: `bearer`, `body`, `body_token`, `query`.
   * Accepts a comma-separated list to probe several in order. Default `bearer`.
   */
  NEPALPAY_REFRESH_STYLE?: string;
  /** Comma-separated allowlist of origins for CORS. Empty means "allow any origin". */
  ALLOWED_ORIGINS?: string;
  /** Max sign-in attempts per IP per minute. */
  LOGIN_RATE_LIMIT_PER_MINUTE?: string;
  /** Set to "1" to log one-line upstream response summaries via `wrangler tail`. */
  DEBUG_UPSTREAM?: string;
  /**
   * Header fingerprint used for upstream calls: `minimal` (default), `product`,
   * `curl`, or `browser`. The edge rejects browser-spoofing header sets.
   */
  NEPALPAY_HEADER_MODE?: string;
  /**
   * Bearer token guarding `GET /api/diag/matrix`. When unset the route 404s, so
   * it is invisible unless deliberately enabled.
   */
  DIAG_TOKEN?: string;
  /**
   * Shared secret every caller must present as `X-Bridge-Key`. Unset means the
   * bridge is open to anyone who knows its URL — fine while wiring a site up,
   * wrong the moment it is public. Set with `wrangler secret put BRIDGE_KEY`.
   */
  BRIDGE_KEY?: string;
  /**
   * Platform rate-limiter binding declared under `ratelimits` in wrangler.jsonc.
   * Counts sign-in attempts across the whole edge rather than per isolate.
   */
  LOGIN_RATE_LIMITER?: RateLimiterBinding;
}

/** Every NepalPay endpoint replies with this envelope. */
export interface NepalPayEnvelope<T = unknown> {
  code: string;
  status: string;
  message: string;
  timeStamp: string;
  data: T;
  errors: Array<{ field?: string; message?: string }>;
}

/** The payload returned by POST /backend/api/auth/signin. */
export interface SignInData {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Identity block that almost every NepalPay endpoint expects in the request body.
 * Derived from the JWT so callers can never spoof another merchant.
 */
export interface UserDetail {
  user: string;
  identificationCode: string;
  subIdentificationCode: string;
}

/** Decrypted contents of a session token handed to the browser. */
export interface SessionPayload {
  v: 1;
  username: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token stops being usable. */
  accessExpiresAt: number;
  merchantCode: string;
  merchantLegalName: string;
  roles: string;
  authorities: string[];
  passwordChangeStatus: string;
  refundEnable: string;
  userDetail: UserDetail;
  /** NCHL edge cookies captured at sign-in, replayed on every upstream call. */
  cookies: string;
  createdAt: number;
  /** Epoch milliseconds of the most recent successful token refresh, if any. */
  renewedAt?: number;
}
