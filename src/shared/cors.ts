import { createMiddleware } from 'hono/factory';

/**
 * CORS for the bridge's own API.
 *
 * With `ALLOWED_ORIGINS` empty the Worker answers any origin, which is
 * convenient while wiring a site up but means anyone can call it. This is a
 * browser-restraint only — it is not an access control.
 */
export function corsMiddleware(opts: {
  sessionHeader: string;
  /** Read the allowlist from the Worker's bindings, per request. */
  allowOrigins?: (env: Record<string, unknown>) => string | undefined;
  /** Extra request header a browser is allowed to send, e.g. the bridge key. */
  extraHeaders?: string[];
}) {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header('Origin');
    const configured = (opts.allowOrigins?.(c.env as Record<string, unknown>) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const allowOrigin =
      configured.length === 0 ? '*' : origin && configured.includes(origin) ? origin : configured[0];

    const allowHeaders = ['Content-Type', 'Authorization', opts.sessionHeader, ...(opts.extraHeaders ?? [])];

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': allowOrigin ?? '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': allowHeaders.join(', '),
      // Only headers listed here are readable from JS on a cross-origin response,
      // so the bridge key stays visible to the caller that sent it.
      'Access-Control-Expose-Headers': [opts.sessionHeader, ...(opts.extraHeaders ?? [])].join(', '),
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (c.req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    await next();

    for (const [name, value] of Object.entries(corsHeaders)) c.res.headers.set(name, value);
  });
}

/** Header carrying a freshly sealed session when a request triggered renewal. */
export const SESSION_HEADER = 'X-Session-Token';

export function bearerFrom(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const header = c.req.header('Authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

export async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
