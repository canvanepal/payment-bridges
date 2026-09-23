import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bearerFrom, corsMiddleware, readJsonBody, SESSION_HEADER } from '../shared/cors';
import { errorBody, secretMissing, successBody } from '../shared/errors';
import { isRateLimited } from '../shared/ratelimit';
import { openSession, sealSession } from '../shared/session';
import { parseHeaderMode } from '../shared/headers';
import { runProbeMatrix } from './diag';
import { callUpstream, decodeJwtPayload, normalizeBaseUrl, str, strArray } from './client';
import {
  applyRefresh,
  expiryFromToken,
  parseRefreshStyles,
  performRefresh,
  refreshPath,
} from './refresh';
import { buildPayload, POST_ROUTES } from './routes';
import type { Env, SessionPayload, SignInData, UserDetail } from './types';

interface AppEnv {
  Bindings: Env;
  Variables: {
    session: SessionPayload;
  };
}

const app = new Hono<AppEnv>();

/** Treat tokens as expired slightly early so they cannot die mid-flight. */
const EXPIRY_SKEW_MS = 30_000;
/** Renew proactively when the access token has this little life left. */
const RENEW_WHEN_WITHIN_MS = 5 * 60_000;

function baseUrlOf(c: { env: Env }): string {
  return normalizeBaseUrl(c.env.NEPALPAY_BASE_URL);
}

/**
 * Exchange the session's refresh token for a new access token.
 *
 * Returns null when renewal is not configured or the upstream rejects the
 * refresh token, in which case the caller must sign in again.
 */
async function renewSession(
  env: Env,
  baseUrl: string,
  session: SessionPayload,
): Promise<{ session: SessionPayload; sealed: string; style: string } | null> {
  const headerMode = parseHeaderMode(env.NEPALPAY_HEADER_MODE);
  const path = refreshPath(env);
  if (!path) return null;

  const outcome = await performRefresh({
    baseUrl,
    path,
    styles: parseRefreshStyles(env.NEPALPAY_REFRESH_STYLE),
    refreshToken: session.refreshToken,
    cookies: session.cookies,
    headerMode,
  });
  if (!outcome) return null;

  const renewed = applyRefresh(session, outcome);
  return {
    session: renewed,
    sealed: await sealSession(renewed, env.SESSION_SECRET),
    style: outcome.style,
  };
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

app.use(
  '/api/*',
  corsMiddleware({
    sessionHeader: SESSION_HEADER,
    allowOrigins: (env) => env.ALLOWED_ORIGINS as string | undefined,
  }),
);

/** Validate the session token and make it available. Rejects expired-or-worse tokens. */
const loadSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.env.SESSION_SECRET) return c.json(secretMissing(), 500);

  const token = bearerFrom(c);
  if (!token) {
    return c.json(
      errorBody('NO_SESSION', 'Missing session token. Call POST /api/auth/login first.'),
      401,
    );
  }

  const session = await openSession<SessionPayload>(token, c.env.SESSION_SECRET);
  if (!session) {
    return c.json(
      errorBody('INVALID_SESSION', 'Session token is invalid or was tampered with.'),
      401,
    );
  }

  c.set('session', session);
  await next();
});

/**
 * Load the session, then renew it when the access token is close to expiring.
 *
 * Renewal is transparent: the refreshed session is returned in the
 * `X-Session-Token` response header, so the client can slide its token forward
 * without ever handling a password again.
 */
const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.env.SESSION_SECRET) return c.json(secretMissing(), 500);

  const token = bearerFrom(c);
  if (!token) {
    return c.json(
      errorBody('NO_SESSION', 'Missing session token. Call POST /api/auth/login first.'),
      401,
    );
  }

  let session = await openSession<SessionPayload>(token, c.env.SESSION_SECRET);
  if (!session) {
    return c.json(
      errorBody('INVALID_SESSION', 'Session token is invalid or was tampered with.'),
      401,
    );
  }

  const now = Date.now();
  const expired = now >= session.accessExpiresAt - EXPIRY_SKEW_MS;
  const dueForRenewal = now >= session.accessExpiresAt - RENEW_WHEN_WITHIN_MS;

  if (expired) {
    const renewed = await renewSession(c.env, baseUrlOf(c), session);
    if (!renewed) {
      return c.json(
        errorBody(
          'SESSION_EXPIRED',
          'The upstream access token expired and could not be renewed. Sign in again.',
        ),
        401,
      );
    }
    session = renewed.session;
    c.header(SESSION_HEADER, renewed.sealed);
  } else if (dueForRenewal) {
    const renewed = await renewSession(c.env, baseUrlOf(c), session);
    if (renewed) {
      session = renewed.session;
      c.header(SESSION_HEADER, renewed.sealed);
    }
    // On failure the current token is still valid, so carry on and retry later.
  }

  c.set('session', session);
  await next();
});

/* ------------------------------------------------------------------ */
/* Auth routes                                                         */
/* ------------------------------------------------------------------ */

app.post('/api/auth/login', async (c) => {
  if (!c.env.SESSION_SECRET) return c.json(secretMissing(), 500);

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const limit = Number(c.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? '') || 10;
  if (isRateLimited(ip, limit)) {
    return c.json(
      errorBody('RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.'),
      429,
    );
  }

  const body = await readJsonBody(c);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) {
    return c.json(errorBody('INVALID_REQUEST', 'Both username and password are required.'), 400);
  }

  let result;
  try {
    result = await callUpstream<SignInData>({
      baseUrl: baseUrlOf(c),
      path: '/backend/api/auth/signin',
      method: 'POST',
      body: { username, password },
      debug: c.env.DEBUG_UPSTREAM === '1',
      headerMode: parseHeaderMode(c.env.NEPALPAY_HEADER_MODE),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return c.json(errorBody('UPSTREAM_UNREACHABLE', `Could not reach NepalPay: ${detail}`), 502);
  }

  if (result.blocked) {
    // Distinguish "the edge refused to talk to us" from "your password is wrong".
    return c.json(errorBody('UPSTREAM_BLOCKED', result.envelope.message), 502);
  }

  if (result.status >= 400 || result.envelope.status !== 'SUCCESS') {
    // Deliberately opaque: don't echo upstream text, which can hint at account existence.
    return c.json(errorBody('AUTH_FAILED', 'Sign-in rejected by NepalPay.'), 401);
  }

  const data = result.envelope.data;
  if (!data?.accessToken) {
    return c.json(errorBody('AUTH_FAILED', 'NepalPay did not return an access token.'), 502);
  }

  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(data.accessToken);
  } catch {
    return c.json(errorBody('AUTH_FAILED', 'NepalPay returned an unreadable access token.'), 502);
  }

  const merchantCode = str(claims.merchantCode);
  if (!merchantCode) {
    return c.json(errorBody('AUTH_FAILED', 'Access token is missing a merchant code.'), 502);
  }

  const userDetail: UserDetail = {
    user: str(claims.sub, username),
    identificationCode: merchantCode,
    subIdentificationCode: merchantCode,
  };

  const expiresIn =
    typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : 3600;
  // Prefer the token's own `exp` claim over the advertised TTL.
  const accessExpiresAt = expiryFromToken(data.accessToken) ?? Date.now() + expiresIn * 1000;

  const session: SessionPayload = {
    v: 1,
    username: userDetail.user,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? '',
    accessExpiresAt,
    merchantCode,
    merchantLegalName: str(claims.merchantLegalName),
    roles: str(claims.roles),
    authorities: strArray(claims.authorities),
    passwordChangeStatus: str(claims.passwordChangeStatus, 'N'),
    refundEnable: str(claims.refundEnable, 'NO'),
    userDetail,
    cookies: result.cookies,
    createdAt: Date.now(),
  };

  const sealed = await sealSession(session, c.env.SESSION_SECRET);

  return c.json({
    code: '000',
    status: 'SUCCESS',
    message: 'Signed in to NepalPay.',
    timeStamp: new Date().toISOString(),
    data: {
      session: sealed,
      expiresAt: session.accessExpiresAt,
      expiresIn,
      autoRenew: refreshPath(c.env) !== null,
      user: {
        username: session.username,
        merchantCode: session.merchantCode,
        merchantLegalName: session.merchantLegalName,
        roles: session.roles,
        authorities: session.authorities,
        passwordChangeStatus: session.passwordChangeStatus,
        refundEnable: session.refundEnable,
      },
    },
    errors: [],
  });
});

/** Identity carried by the session token — safe to expose, holds no secrets. */
app.get('/api/auth/me', loadSession, (c) => {
  const session = c.get('session');
  return c.json({
    code: '000',
    status: 'SUCCESS',
    message: 'Session is active.',
    timeStamp: new Date().toISOString(),
    data: {
      username: session.username,
      merchantCode: session.merchantCode,
      merchantLegalName: session.merchantLegalName,
      roles: session.roles,
      authorities: session.authorities,
      passwordChangeStatus: session.passwordChangeStatus,
      refundEnable: session.refundEnable,
      expiresAt: session.accessExpiresAt,
      createdAt: session.createdAt,
      renewedAt: session.renewedAt ?? null,
      autoRenew: refreshPath(c.env) !== null,
    },
    errors: [],
  });
});

/**
 * Force a renewal regardless of how much life the access token has left. Useful
 * to validate your `NEPALPAY_REFRESH_PATH` / `NEPALPAY_REFRESH_STYLE` config.
 */
app.post('/api/auth/refresh', loadSession, async (c) => {
  if (!refreshPath(c.env)) {
    return c.json(
      errorBody(
        'REFRESH_NOT_CONFIGURED',
        'Set NEPALPAY_REFRESH_PATH to enable session renewal.',
      ),
      501,
    );
  }

  const renewed = await renewSession(c.env, baseUrlOf(c), c.get('session'));
  if (!renewed) {
    return c.json(
      errorBody(
        'REFRESH_FAILED',
        'NepalPay rejected the refresh token for every configured style. Sign in again.',
      ),
      401,
    );
  }

  return c.json({
    code: '000',
    status: 'SUCCESS',
    message: 'Session renewed.',
    timeStamp: new Date().toISOString(),
    data: {
      session: renewed.sealed,
      expiresAt: renewed.session.accessExpiresAt,
      renewedAt: renewed.session.renewedAt,
      style: renewed.style,
    },
    errors: [],
  });
});

/**
 * Sessions are stateless, so there is nothing to revoke server-side: the client
 * simply discards its token. Kept for a clean frontend contract.
 */
app.post('/api/auth/logout', (c) =>
  c.json({
    code: '000',
    status: 'SUCCESS',
    message: 'Session discarded. Delete the token on the client.',
    timeStamp: new Date().toISOString(),
    data: null,
    errors: [],
  }),
);

/* ------------------------------------------------------------------ */
/* Data routes                                                         */
/* ------------------------------------------------------------------ */

for (const spec of POST_ROUTES) {
  const method = spec.method ?? 'POST';

  const handler = async (c: Context<AppEnv>) => {
    const session = c.get('session');
    const incoming = method === 'POST' ? await readJsonBody(c) : {};
    const body = buildPayload(session, incoming, spec);

    const result = await callUpstream({
      baseUrl: baseUrlOf(c),
      path: spec.upstream,
      method,
      body: method === 'POST' ? body : undefined,
      accessToken: session.accessToken,
      cookies: session.cookies,
      headerMode: parseHeaderMode(c.env.NEPALPAY_HEADER_MODE),
    });

    if (result.blocked) return c.json(errorBody('UPSTREAM_BLOCKED', result.envelope.message), 502);

    return c.json(result.envelope, result.status as ContentfulStatusCode);
  };

  if (method === 'GET') app.get(`/api${spec.path}`, requireSession, handler);
  else app.post(`/api${spec.path}`, requireSession, handler);
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

app.get('/api/health', (c) =>
  c.json({
    code: '000',
    status: 'SUCCESS',
    message: 'ok',
    timeStamp: new Date().toISOString(),
    data: {
      upstream: baseUrlOf(c),
      sessionSecretConfigured: Boolean(c.env.SESSION_SECRET),
      autoRenew: refreshPath(c.env) !== null,
      refreshStyles: parseRefreshStyles(c.env.NEPALPAY_REFRESH_STYLE),
      headerMode: parseHeaderMode(c.env.NEPALPAY_HEADER_MODE),
    },
    errors: [],
  }),
);

/**
 * Credential-free header-profile probe, run from this Worker's own egress.
 * 404s unless `DIAG_TOKEN` is set, and the target path plus body are hardcoded.
 */
app.get('/api/diag/matrix', async (c) => {
  const token = c.env.DIAG_TOKEN?.trim();
  if (!token) return c.json(errorBody('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`), 404);

  if (bearerFrom(c) !== token) {
    return c.json(errorBody('NO_SESSION', 'Send the diagnostic token as a Bearer token.'), 401);
  }

  const report = await runProbeMatrix(baseUrlOf(c), c.env);
  return c.json({
    code: '000',
    status: 'SUCCESS',
    message: report.working.length
      ? `Profiles reaching the API: ${report.working.join(', ')}`
      : 'No header profile reached the API from this egress.',
    timeStamp: new Date().toISOString(),
    data: report,
    errors: [],
  });
});

app.get('/api', (c) =>
  c.json({
    code: '000',
    status: 'SUCCESS',
    message: 'NepalPay bridge routes',
    timeStamp: new Date().toISOString(),
    data: {
      auth: [
        'POST /api/auth/login',
        'GET /api/auth/me',
        'POST /api/auth/refresh',
        'POST /api/auth/logout',
      ],
      endpoints: POST_ROUTES.map((spec) => ({
        route: `${spec.method ?? 'POST'} /api${spec.path}`,
        upstream: spec.upstream,
        title: spec.title ?? '',
        defaults: spec.defaults ?? null,
      })),
      renewal: {
        header: SESSION_HEADER,
        autoRenew: refreshPath(c.env) !== null,
        styles: parseRefreshStyles(c.env.NEPALPAY_REFRESH_STYLE),
      },
      headerMode: parseHeaderMode(c.env.NEPALPAY_HEADER_MODE),
    },
    errors: [],
  }),
);

// Normally served by the `assets` binding in wrangler.jsonc (public/index.html).
app.get('/', (c) =>
  c.text('nepalpay-bridge is running. Test console: public/index.html. Routes: GET /api\n'),
);

app.notFound((c) =>
  c.json(errorBody('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`), 404),
);

export default app;
