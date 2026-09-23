import { parseHeaderMode, upstreamHeaders, type HeaderMode } from '../shared/headers';
import type { NepalPayEnvelope } from './types';

export const DEFAULT_BASE_URL = 'https://business.nepalpay.com.np';

/** Give up rather than let a hung upstream burn the Worker's CPU budget. */
const UPSTREAM_TIMEOUT_MS = 15_000;

export interface UpstreamResult<T = unknown> {
  status: number;
  envelope: NepalPayEnvelope<T>;
  cookies: string;
  /** True when the F5 ASM edge rejected the request before it reached the API. */
  blocked: boolean;
}

/**
 * The portal's edge returns HTTP 200 with an HTML body when it rejects a client,
 * which is easy to mistake for success. Detect it so callers fail loudly with an
 * actionable diagnosis instead of a misleading auth error.
 */
export function isBlockedResponse(contentType: string, body: string): boolean {
  if (/text\/html/i.test(contentType) && /Request Rejected|support ID|\/TSPD\//i.test(body)) {
    return true;
  }
  // Cloudflare's own 52x errors mean the origin never produced a usable response.
  // Observed from Cloudflare's edge against this portal, consistently.
  if (!/application\/json/i.test(contentType) && /\berror code: 52[0-7]\b/i.test(body)) {
    return true;
  }
  return false;
}

const BLOCKED_MESSAGE =
  'The NepalPay edge refused this request before it reached the API (an F5 ASM ' +
  'rejection page, or a 52x origin error). The usual cause is a browser-spoofing ' +
  'header set: the edge rejects a Mozilla/Chrome User-Agent on a non-browser TLS ' +
  'connection. Check NEPALPAY_HEADER_MODE, then GET /api/diag/matrix to see which ' +
  'profiles this Worker can use.';

export function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Merge `Set-Cookie` values into a single `Cookie` header.
 *
 * The portal sets NCHL-prefixed edge cookies on sign-in. Later API calls also send
 * them alongside the Bearer token, so we keep the jar alive for the whole session.
 */
export function mergeCookies(existing: string, setCookies: readonly string[]): string {
  const jar = new Map<string, string>();

  const absorb = (pair: string): void => {
    const index = pair.indexOf('=');
    if (index <= 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name && value) jar.set(name, value);
  };

  for (const pair of existing.split(';')) absorb(pair);
  for (const header of setCookies) {
    const first = header.split(';')[0];
    if (first) absorb(first);
  }

  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Decode a JWT payload without verifying the signature (we trust it because TLS delivered it). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('Malformed JWT: missing payload segment');

  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Perform a single call against the NepalPay backend. */
export async function callUpstream<T = unknown>(options: {
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  accessToken?: string;
  cookies?: string;
  /** Log a one-line summary of the upstream response. Diagnostic aid. */
  debug?: boolean;
  /** Header fingerprint profile. Defaults to the one measured to pass the edge. */
  headerMode?: HeaderMode;
}): Promise<UpstreamResult<T>> {
  const base = normalizeBaseUrl(options.baseUrl);
  const origin = new URL(base).origin;
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');

  const headers = upstreamHeaders({
    mode: options.headerMode ?? parseHeaderMode(undefined),
    origin,
    hasBody: options.body !== undefined,
    accessToken: options.accessToken,
    cookies: options.cookies,
  });

  const response = await fetch(`${base}${options.path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const raw = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const blocked = isBlockedResponse(contentType, raw);

  if (options.debug) {
    const flat = raw.replace(/\s+/g, ' ').slice(0, 300);
    console.log(`[upstream] ${method} ${options.path} -> ${response.status} ${contentType} :: ${flat}`);
  }

  let envelope: NepalPayEnvelope<T>;
  try {
    envelope = JSON.parse(raw) as NepalPayEnvelope<T>;
  } catch {
    envelope = {
      code: blocked ? '999' : response.ok ? '000' : '999',
      status: blocked ? 'BLOCKED' : response.ok ? 'SUCCESS' : 'FAILED',
      message: blocked
        ? BLOCKED_MESSAGE
        : `Upstream returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`,
      timeStamp: new Date().toISOString(),
      data: null as T,
      errors: [],
    };
  }

  const setCookies =
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];

  return {
    status: response.status,
    envelope,
    cookies: mergeCookies(options.cookies ?? '', setCookies),
    blocked,
  };
}
