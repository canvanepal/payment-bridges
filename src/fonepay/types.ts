import type { RateLimiterBinding } from '../shared/ratelimit';
import type { SealedSession } from '../shared/session';

/** Bindings available to the Fonepay bridge at runtime. */
export interface Env {
  /** Data API root. Defaults to the corporate gateway's `/corporate/api`. */
  FONEPAY_API_BASE_URL?: string;
  /** Auth root. Defaults to the corporate gateway's `/corporate/auth`. */
  FONEPAY_AUTH_BASE_URL?: string;
  /** Value sent as `Origin`/`Referer`; the gateway expects the portal's own origin. */
  FONEPAY_ORIGIN?: string;
  /** OAuth client identifier the portal sends on sign-in. */
  FONEPAY_CLIENT_CODE?: string;
  /** User-Agent for upstream calls. The gateway does not require a browser one. */
  FONEPAY_USER_AGENT?: string;
  /** base64url-encoded 32-byte key used to seal/unseal session tokens. */
  SESSION_SECRET: string;
  /** Comma-separated allowlist of origins for CORS. Empty means "allow any origin". */
  ALLOWED_ORIGINS?: string;
  /** Max sign-in attempts per IP per minute. */
  LOGIN_RATE_LIMIT_PER_MINUTE?: string;
  /** Set to "1" to log one-line upstream response summaries via `wrangler tail`. */
  DEBUG_UPSTREAM?: string;
  /**
   * Set to "0" to disable renew-by-re-signin. On by default: Fonepay issues a
   * refresh token but exposes no refresh endpoint, so renewal signs in again
   * with the credentials kept inside the sealed session.
   */
  FONEPAY_RENEW_ON_EXPIRY?: string;
  /**
   * Shared secret every caller must present as `X-Bridge-Key`. Unset means the
   * bridge is open to anyone who knows its URL. Set with
   * `wrangler secret put BRIDGE_KEY`.
   */
  BRIDGE_KEY?: string;
  /**
   * Platform rate-limiter binding declared under `ratelimits` in
   * wrangler.fonepay.jsonc.
   */
  LOGIN_RATE_LIMITER?: RateLimiterBinding;
}

/**
 * Fonepay's envelopes vary by endpoint: most wrap a payload in
 * `{message, code, isSuccess, data}`, but several return the payload bare.
 * `data`, `body` and the loose index signature let one type cover all of them.
 */
export interface FonepayEnvelope<T = unknown> {
  message?: string;
  code?: string;
  isSuccess?: boolean;
  success?: boolean;
  data?: T;
  body?: unknown;
  [key: string]: unknown;
}

/** The sign-in response, before the bridge normalises it. */
export interface LoginData {
  accessToken?: string;
  refreshToken?: string;
  tempToken?: string;
  /** Token lifetime as reported by the gateway; unit is inferred. */
  expireTime?: number | string;
  tokenCreatedDate?: number | string;
  userId?: number | string;
  username?: string;
  firstLogin?: boolean;
  passwordExpired?: boolean;
  otpType?: string;
  navigationRoleResponse?: unknown;
  message?: string;
  success?: boolean;
}

export interface LinkedMerchant {
  id: number | string;
  merchantName?: string;
  merchantNickname?: string;
  terminalName?: string;
  fonepayPan?: string;
  status?: string;
}

/** Credentials kept inside the sealed session so expiry can be renewed. */
export interface StoredCredentials {
  emailOrUsername: string;
  password: string;
}

/** A signed-in Fonepay session. */
export interface FonepaySession extends SealedSession {
  v: 1;
  provider: 'fonepay';
  accessToken: string;
  refreshToken: string;
  /** Present only when the account needs an OTP step; the bridge can finish it. */
  tempToken: string;
  /**
   * Epoch ms when the access token stops being usable. Inferred from
   * `expireTime`; a conservative default is used when it cannot be parsed.
   */
  accessExpiresAt: number;
  /** Wall-clock ms of the sign-in that produced this token. */
  signedInAt: number;
  username: string;
  corporateCode: string;
  userId: string;
  displayName: string;
  otpType: string;
  /** Merchants this account may read. Empty means "not verified". */
  linkedMerchants: LinkedMerchant[];
  credentials: StoredCredentials;
  /** Epoch ms of the most recent successful re-sign-in. */
  renewedAt?: number;
}

/** A sign-in that stopped short of a session because an OTP is required. */
export interface FonepayPendingSession extends SealedSession {
  v: 1;
  provider: 'fonepay-pending';
  /** The temporary token the OTP step must be authorised with. */
  accessToken: string;
  username: string;
  corporateCode: string;
  otpType: string;
  credentials: StoredCredentials;
  createdAt: number;
}
