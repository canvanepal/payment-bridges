import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bearerFrom, corsMiddleware, readJsonBody, SESSION_HEADER } from '../shared/cors';
import { errorBody, secretMissing, successBody } from '../shared/errors';
import { checkRateLimit } from '../shared/ratelimit';
import { openSession, sealSession } from '../shared/session';
import { parseHeaderMode } from '../shared/headers';
import { defaultCache } from '../shared/kvcache';
import { REF_CACHE_HEADER, withRefCache } from '../shared/refcache';
import { renewOnce } from '../shared/renewal';
import { BRIDGE_KEY_HEADER, bridgeKeyOf, requireBridgeKey } from '../shared/bridge-key';
import { COLLECT_RETRY_AFTER_MS, openTicket, sealTicket } from '../shared/collect';
import { collectStatus, startCollect } from './collect';
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

  // Deduplicate by the token being renewed, so twenty requests that notice the
  // same near-expiry token at once perform one refresh between them rather than
  // twenty. A cache hit reports `style: "shared"` because no refresh ran here.
  let style = 'shared';
  const sealed = await renewOnce({
    sessionToken: session.accessToken,
    cache: defaultCache(),
    renew: async () => {
      const outcome = await performRefresh({
        baseUrl,
        path,
        styles: parseRefreshStyles(env.NEPALPAY_REFRESH_STYLE),
        refreshToken: session.refreshToken,
        cookies: session.cookies,
        headerMode,
      });
      if (!outcome) return null;
      style = outcome.style;
      return sealSession(applyRefresh(session, outcome), env.SESSION_SECRET);
    },
  });

  if (!sealed) return null;

  const renewed = await openSession<SessionPayload>(sealed, env.SESSION_SECRET);
  if (!renewed) return null;
  return { session: renewed, sealed, style };
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

app.use(
  '/api/*',
  corsMiddleware({
    sessionHeader: SESSION_HEADER,
    allowOrigins: (env) => env.ALLOWED_ORIGINS as string | undefined,
    extraHeaders: [BRIDGE_KEY_HEADER],
  }),
);

// Manned door. Does nothing until BRIDGE_KEY is set, then every /api/* call
// needs the shared secret — without it the bridge is a credential relay that
// anyone who finds the URL can drive.
app.use('/api/*', requireBridgeKey());

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
  if (await checkRateLimit(c.env, ip, limit)) {
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
/* Collect — take a payment and learn when it lands                     */
/* ------------------------------------------------------------------ */

/**
 * Mint a dynamic QR for an amount and return a ticket to watch it with.
 *
 * The QR is per-payment, so it is minted here rather than reusing the generic
 * `/api/qr` route: this also captures the correlation values the status call
 * needs, which the plain route would throw away.
 */
app.post('/api/collect', requireSession, async (c) => {
  const outcome = await startCollect({
    env: c.env,
    session: c.get('session'),
    input: await readJsonBody(c),
  });

  if (!outcome.ok) return c.json(errorBody(outcome.code, outcome.message), outcome.status as ContentfulStatusCode);

  const { ticket } = outcome;
  const sealed = await sealTicket(ticket, c.env.SESSION_SECRET);

  return c.json(
    successBody('QR created. Poll statusPath until it reports PAID.', {
      collectId: ticket.collectId,
      amount: ticket.amount,
      remarks: ticket.remarks,
      orderId: ticket.orderId,
      qrString: outcome.qrString,
      expiresAt: ticket.expiresAt,
      ttlSeconds: Math.round((ticket.expiresAt - ticket.createdAt) / 1000),
      statusPath: `/api/collect/${sealed}`,
      retryAfterMs: COLLECT_RETRY_AFTER_MS,
      keys: ticket.keys,
      realtime: ticket.realtime ?? null,
      upstream: {
        validationTraceId: ticket.keys.validationTraceId,
        openWebSocket: outcome.qr.openWebSocket ?? null,
      },
    }),
  );
});

/**
 * Poll a collect. Answers PENDING while nothing has arrived, PAID once a
 * transaction matches, and EXPIRED after the ticket's own lifetime.
 *
 * The verdict is cached for a couple of seconds so several watchers of one QR do
 * not each trigger their own scan of the merchant's transactions.
 */
app.get('/api/collect/:id', requireSession, async (c) => {
  const ticket = await openTicket(c.req.param('id'), c.env.SESSION_SECRET);
  if (!ticket) {
    return c.json(
      errorBody('INVALID_COLLECT', 'This collect id is invalid or was tampered with.'),
      401,
    );
  }

  if (ticket.provider !== 'nepalpay') {
    return c.json(
      errorBody('WRONG_PROVIDER', 'This collect id belongs to the Fonepay bridge.'),
      400,
    );
  }

  const outcome = await collectStatus({
    env: c.env,
    session: c.get('session'),
    ticket,
  });

  const message =
    outcome.state === 'PAID'
      ? 'Payment received.'
      : outcome.state === 'EXPIRED'
        ? 'This QR expired.'
        : 'No payment yet.';

  return c.json(
    successBody(message, {
      collectId: ticket.collectId,
      state: outcome.state,
      amount: ticket.amount,
      expiresAt: ticket.expiresAt,
      retryAfterMs: outcome.state === 'PENDING' ? COLLECT_RETRY_AFTER_MS : null,
      matchedBy: outcome.matchedBy ?? null,
      transaction: outcome.transaction ?? null,
      note: outcome.note ?? null,
      upstreamError: outcome.upstreamError ?? null,
    }),
  );
});

/* ------------------------------------------------------------------ */
/* Data routes                                                         */
/* ------------------------------------------------------------------ */

for (const spec of POST_ROUTES) {
  const method = spec.method ?? 'POST';

  const handler = async (c: Context<AppEnv>) => {
    const session = c.get('session');
    const incoming = method === 'POST' ? await readJsonBody(c) : {};
    const body = buildPayload(session, incoming, spec);

    // Reference routes (`cacheSeconds`) answer from a merchant-scoped cache;
    // everything else always goes upstream.
    const { result, hit } = await withRefCache({
      cache: defaultCache(),
      ttlSeconds: spec.cacheSeconds,
      route: spec.path,
      scope: session.merchantCode,
      request: { upstream: spec.upstream, body },
      cacheable: (r) => !r.blocked && r.status >= 200 && r.status < 300,
      run: () =>
        callUpstream({
          baseUrl: baseUrlOf(c),
          path: spec.upstream,
          method,
          body: method === 'POST' ? body : undefined,
          accessToken: session.accessToken,
          cookies: session.cookies,
          headerMode: parseHeaderMode(c.env.NEPALPAY_HEADER_MODE),
        }),
    });
    if (hit) c.header(REF_CACHE_HEADER, 'HIT');

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
      provider: 'nepalpay',
      upstream: baseUrlOf(c),
      sessionSecretConfigured: Boolean(c.env.SESSION_SECRET),
      secure: {
        bridgeKeyRequired: bridgeKeyOf(c.env) !== null,
        edgeRateLimiterBound: Boolean(c.env.LOGIN_RATE_LIMITER),
        allowedOrigins: (c.env.ALLOWED_ORIGINS ?? '') || '*',
        loginRateLimitPerMinute: Number(c.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? '') || 10,
      },
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
      collect: [
        'POST /api/collect  { amount, storeLabel?, terminal?, remarks?, expiresInSeconds? }',
        'GET /api/collect/:id  -> PENDING | PAID | EXPIRED',
      ],
      security: {
        bridgeKeyHeader: BRIDGE_KEY_HEADER,
        bridgeKeyRequired: bridgeKeyOf(c.env) !== null,
      },
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
