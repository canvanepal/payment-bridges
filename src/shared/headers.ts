/**
 * Header profiles for upstream calls.
 *
 * The portal's edge (F5 ASM) treats a *browser User-Agent on a non-browser TLS
 * connection* as spoofing and rejects the request before it reaches the API.
 * Measured on 2026-09-23 against `POST /backend/api/auth/signin` with an empty
 * body — a bare request answered with the API's own JSON envelope, while the same
 * request carrying `User-Agent: Mozilla/5.0 … Firefox/156.0` was answered with the
 * F5 `Request Rejected` page:
 *
 *   bare / curl UA                        -> 400 application/json
 *   + browser User-Agent                  -> 200 text/html  (rejected)
 *   + browser UA + Accept-Language        -> 400 application/json
 *   + Origin/Referer, no browser UA       -> 400 application/json
 *   + sec-ch-ua / sec-fetch (browser UA)  -> 200 text/html  (rejected)
 *
 * So the honest move is to *stop pretending to be a browser*: identify as the
 * bridge, and send only the headers the API actually needs.
 */
export type HeaderMode = 'minimal' | 'product' | 'curl' | 'browser';

export const HEADER_MODES: readonly HeaderMode[] = ['minimal', 'product', 'curl', 'browser'];

export const PRODUCT_UA = 'nepalpay-bridge/1.0';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';

export function parseHeaderMode(value: string | undefined): HeaderMode {
  const mode = (value ?? '').trim().toLowerCase();
  return (HEADER_MODES as readonly string[]).includes(mode) ? (mode as HeaderMode) : 'minimal';
}

export interface HeaderOptions {
  mode: HeaderMode;
  /** Origin of the upstream, used for `Origin`/`Referer` in `browser` mode only. */
  origin: string;
  hasBody: boolean;
  accessToken?: string;
  cookies?: string;
}

/**
 * Build the header set for one upstream call. Authentication (`Authorization`,
 * `Cookie`) and framing (`Content-Type`) are always applied — the mode only
 * controls the *fingerprint* headers.
 */
export function upstreamHeaders(options: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {};

  // The API answers JSON; asking for it explicitly is accepted in every mode.
  headers.Accept = 'application/json, text/plain, */*';

  if (options.mode === 'product') headers['User-Agent'] = PRODUCT_UA;
  if (options.mode === 'curl') headers['User-Agent'] = 'curl/8.5.0';

  if (options.mode === 'browser') {
    headers['User-Agent'] = BROWSER_UA;
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers.Origin = options.origin;
    headers.Referer = `${options.origin}/`;
  }

  if (options.hasBody) headers['Content-Type'] = 'application/json';
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  if (options.cookies) headers.Cookie = options.cookies;

  return headers;
}
