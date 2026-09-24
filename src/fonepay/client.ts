import type { Env, FonepayEnvelope, LinkedMerchant, LoginData } from './types';

export const DEFAULT_API_BASE_URL = 'https://corporate-kong.fonepay.com/corporate/api';
export const DEFAULT_AUTH_BASE_URL = 'https://corporate-kong.fonepay.com/corporate/auth';
export const DEFAULT_ORIGIN = 'https://fonebiz.fonepay.com';
export const DEFAULT_CLIENT_CODE = 'CORPORATE_USER';
export const DEFAULT_USER_AGENT = 'fonepay-bridge/1.0';

/** Give up rather than let a hung upstream burn the Worker's CPU budget. */
const UPSTREAM_TIMEOUT_MS = 20_000;

export const LOGIN_PATH = '/authentication/corporate-login';
export const EMAIL_LOOKUP_PATH = '/authentication/email-lookup';
export const VALIDATE_OTP_PATH = '/authentication/validateLoginWithOtpCode';

/**
 * Four seconds short of a minute is the fallback lifetime when the gateway's
 * `expireTime` cannot be interpreted. Deliberately pessimistic: an early
 * re-sign-in costs one request, an expired token costs the caller their call.
 */
export const FALLBACK_TTL_MS = 4 * 60_000;

export interface UpstreamResult {
  status: number;
  /** Upstream body, untouched. */
  body: unknown;
  /** Upstream text, kept for diagnostics on unparseable responses. */
  raw: string;
  contentType: string;
  /** True when the upstream treated the call as successful. */
  ok: boolean;
  /** Human-readable reason, taken from the upstream body when available. */
  message: string;
}

export function normalizeBase(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, '');
}

export function apiBase(env: Env): string {
  return normalizeBase(env.FONEPAY_API_BASE_URL, DEFAULT_API_BASE_URL);
}

export function authBase(env: Env): string {
  return normalizeBase(env.FONEPAY_AUTH_BASE_URL, DEFAULT_AUTH_BASE_URL);
}

export function clientCode(env: Env): string {
  return env.FONEPAY_CLIENT_CODE?.trim() || DEFAULT_CLIENT_CODE;
}

export function portalOrigin(env: Env): string {
  return normalizeBase(env.FONEPAY_ORIGIN, DEFAULT_ORIGIN);
}

export function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function asJson(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Headers for one upstream call.
 *
 * Unlike NepalPay's edge, the Fonepay gateway is not fingerprint-sensitive — it
 * simply expects the portal's origin, so a plain honest client works.
 */
export function upstreamHeaders(options: {
  env: Env;
  hasBody: boolean;
  accessToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: portalOrigin(options.env),
    Referer: `${portalOrigin(options.env)}/`,
    'User-Agent': options.env.FONEPAY_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };

  if (options.hasBody) headers['Content-Type'] = 'application/json';
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  return headers;
}

/** Perform a single call against the Fonepay corporate gateway. */
export async function callUpstream(options: {
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  accessToken?: string;
  env: Env;
}): Promise<UpstreamResult> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');

  const response = await fetch(`${normalizeBase(options.baseUrl, '')}${options.path}`, {
    method,
    headers: upstreamHeaders({
      env: options.env,
      hasBody: options.body !== undefined,
      accessToken: options.accessToken,
    }),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const raw = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parseFailed = true;
  }

  if (options.env.DEBUG_UPSTREAM === '1') {
    const flat = raw.replace(/\s+/g, ' ').slice(0, 300);
    console.log(`[fonepay] ${method} ${options.path} -> ${response.status} ${contentType} :: ${flat}`);
  }

  const envelope = asJson(parsed);
  // A 2xx is success unless the body explicitly says otherwise — several
  // endpoints answer 202 Accepted for reads, which is easy to misread as pending.
  const ok =
    !parseFailed &&
    response.status < 400 &&
    envelope?.isSuccess !== false &&
    envelope?.success !== false;

  return {
    status: response.status,
    body: parsed,
    raw,
    contentType,
    ok,
    message: describe(envelope, parsed, raw, response.status, parseFailed),
  };
}

function describe(
  envelope: Record<string, unknown> | undefined,
  parsed: unknown,
  raw: string,
  status: number,
  parseFailed: boolean,
): string {
  if (envelope) {
    for (const key of ['message', 'error_description', 'error']) {
      const value = envelope[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return `Fonepay answered HTTP ${status}.`;
  }
  if (parseFailed) {
    return `Fonepay returned a non-JSON body (HTTP ${status}): ${raw.slice(0, 200)}`;
  }
  if (Array.isArray(parsed)) return 'Fonepay answered with a list.';
  return `Fonepay answered HTTP ${status}.`;
}

/**
 * Unwrap an endpoint's payload.
 *
 * Most gateway endpoints nest their result under `data`; a few answer flat. Used
 * where the bridge needs a response's *fields* rather than just its status —
 * reading the envelope by mistake yields empty strings and a confusing failure.
 */
export function payloadOf(body: unknown): Record<string, unknown> {
  const root = asJson(body);
  if (!root) return {};
  return asJson(root.data) ?? root;
}

/**
 * Pull the sign-in fields out of whichever shape the gateway replies with.
 * Most endpoints wrap their payload in `data`; the login response has also been
 * seen flat, so both are accepted.
 */
export function extractLoginData(body: unknown): LoginData {
  const root = asJson(body);
  if (!root) return {};

  const nested = asJson(root.data);
  const candidates = nested ? [nested, root] : [root];

  for (const candidate of candidates) {
    if (typeof candidate.accessToken === 'string' && candidate.accessToken) {
      return candidate as LoginData;
    }
  }

  // No token anywhere: return whichever level carries a usable message.
  return (nested ? { ...nested, message: str(root.message, str(nested.message)) } : root) as LoginData;
}

/**
 * Work out when the access token dies.
 *
 * The token is a JWE (the payload is encrypted), so its own `exp` is not
 * readable. The gateway instead reports `expireTime`, whose unit is not
 * documented — it could be a duration, epoch seconds or epoch milliseconds. The
 * magnitude disambiguates, and anything implausible falls back to a short TTL so
 * the session re-signs in rather than handing the caller a dead token.
 */
export function expiryFromLogin(data: LoginData, now = Date.now()): number {
  const raw = data.expireTime;
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Epoch milliseconds (after ~2001) or seconds (after ~1970).
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    // A duration in seconds is the common case; guard against tiny values.
    if (value >= 30) return now + value * 1000;
    // Anything smaller is more likely milliseconds.
    if (value >= 1000) return now + value;
  }

  return now + FALLBACK_TTL_MS;
}

/** Normalise the linked-merchant list, which arrives bare or inside `data`. */
export function extractLinkedMerchants(body: unknown): LinkedMerchant[] {
  const root = asJson(body);
  const list = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
      ? (root?.data as unknown[])
      : [];

  return list
    .map((item) => asJson(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      id: (item.id ?? '') as number | string,
      merchantName: str(item.merchantName),
      merchantNickname: str(item.merchantNickname),
      terminalName: str(item.terminalName),
      fonepayPan: str(item.fonepayPan),
      status: str(item.status),
    }))
    .filter((merchant) => merchant.id !== '');
}

export function defaultMerchantId(session: { linkedMerchants: LinkedMerchant[] }): string {
  const first = session.linkedMerchants[0];
  return first ? String(first.id) : '';
}

export function merchantIsAllowed(
  session: { linkedMerchants: LinkedMerchant[] },
  merchantId: string,
): boolean {
  // An unverified list (a failed lookup at sign-in) must not lock the caller out.
  if (session.linkedMerchants.length === 0) return true;
  return session.linkedMerchants.some((merchant) => String(merchant.id) === merchantId);
}

export function isEnvelope(value: unknown): value is FonepayEnvelope {
  return Boolean(asJson(value));
}
