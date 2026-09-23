import type { HeaderMode } from '../shared/headers';
import { callUpstream, decodeJwtPayload } from './client';
import type { Env, SessionPayload } from './types';

const STYLES = ['bearer', 'body', 'body_token', 'query'] as const;
export type RefreshStyle = (typeof STYLES)[number];

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface RefreshOutcome {
  tokens: TokenSet;
  cookies: string;
  expiresAt: number;
  style: RefreshStyle;
}

type Json = Record<string, unknown>;

const ACCESS_KEYS = ['accessToken', 'access_token', 'token', 'jwt', 'idToken', 'id_token'];
const REFRESH_KEYS = ['refreshToken', 'refresh_token'];
const EXPIRES_KEYS = ['expiresIn', 'expires_in', 'expiresInSeconds'];

function asJson(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function firstString(obj: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(obj: Json, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Pull a token set out of whichever shape the backend replies with. We do not
 * know the refresh response schema yet, so accept the common nesting levels and
 * key spellings rather than assuming one.
 */
export function extractTokens(payload: unknown): TokenSet | null {
  const root = asJson(payload);
  if (!root) return null;

  const candidates: Json[] = [root];

  const data = asJson(root.data);
  if (data) {
    candidates.push(data);
    const nested = asJson(data.data);
    if (nested) candidates.push(nested);
  }

  const result = asJson(root.result);
  if (result) candidates.push(result);

  for (const candidate of candidates) {
    const accessToken = firstString(candidate, ACCESS_KEYS);
    if (!accessToken) continue;
    return {
      accessToken,
      refreshToken: firstString(candidate, REFRESH_KEYS),
      expiresIn: firstNumber(candidate, EXPIRES_KEYS),
    };
  }

  return null;
}

/** Parse `NEPALPAY_REFRESH_STYLE`, ignoring anything unrecognised. */
export function parseRefreshStyles(value: string | undefined): RefreshStyle[] {
  const parts = (value ?? 'bearer')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const valid = parts.filter((part): part is RefreshStyle =>
    (STYLES as readonly string[]).includes(part),
  );

  return valid.length > 0 ? valid : ['bearer'];
}

export function refreshPath(env: Env): string | null {
  const path = env.NEPALPAY_REFRESH_PATH?.trim();
  return path && path.startsWith('/') ? path : null;
}

/**
 * How the refresh token is presented upstream. We do not know which the backend
 * expects, so this is configurable and several styles can be listed to probe.
 */
function buildRefreshRequest(
  style: RefreshStyle,
  path: string,
  refreshToken: string,
): { path: string; body?: unknown; accessToken?: string } {
  switch (style) {
    case 'bearer':
      return { path, accessToken: refreshToken };
    case 'body':
      return { path, body: { refreshToken } };
    case 'body_token':
      return { path, body: { token: refreshToken } };
    case 'query':
      return { path: `${path}?refreshToken=${encodeURIComponent(refreshToken)}`, body: {} };
  }
}

/** Expiry implied by the access token's own `exp` claim, in epoch milliseconds. */
export function expiryFromToken(accessToken: string): number | null {
  try {
    const exp = decodeJwtPayload(accessToken).exp;
    return typeof exp === 'number' && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the refresh token for a new access token, trying each configured
 * style in order. Returns null when every attempt is rejected, which means the
 * caller must sign in again.
 */
export async function performRefresh(options: {
  baseUrl: string;
  path: string;
  styles: RefreshStyle[];
  refreshToken: string;
  cookies: string;
  headerMode?: HeaderMode;
}): Promise<RefreshOutcome | null> {
  if (!options.refreshToken) return null;

  for (const style of options.styles) {
    const request = buildRefreshRequest(style, options.path, options.refreshToken);

    let result;
    try {
      result = await callUpstream({
        baseUrl: options.baseUrl,
        path: request.path,
        method: 'POST',
        body: request.body,
        accessToken: request.accessToken,
        cookies: options.cookies,
        headerMode: options.headerMode,
      });
    } catch {
      continue;
    }

    if (result.status >= 400 || result.envelope.status !== 'SUCCESS') continue;

    const tokens = extractTokens(result.envelope);
    if (!tokens) continue;

    const expiresAt =
      expiryFromToken(tokens.accessToken) ??
      (tokens.expiresIn && tokens.expiresIn > 0 ? Date.now() + tokens.expiresIn * 1000 : null);

    if (!expiresAt) continue;

    return { tokens, cookies: result.cookies, expiresAt, style };
  }

  return null;
}

/** Fold a successful refresh back into the session. */
export function applyRefresh(session: SessionPayload, outcome: RefreshOutcome): SessionPayload {
  return {
    ...session,
    accessToken: outcome.tokens.accessToken,
    refreshToken: outcome.tokens.refreshToken ?? session.refreshToken,
    accessExpiresAt: outcome.expiresAt,
    cookies: outcome.cookies || session.cookies,
    renewedAt: Date.now(),
  };
}
