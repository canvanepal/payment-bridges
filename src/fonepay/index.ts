import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bearerFrom, corsMiddleware, readJsonBody, SESSION_HEADER } from '../shared/cors';
import { errorBody, secretMissing, successBody } from '../shared/errors';
import { checkRateLimit } from '../shared/ratelimit';
import { openSession, sealSession } from '../shared/session';
import { defaultCache } from '../shared/kvcache';
import { REF_CACHE_HEADER, withRefCache } from '../shared/refcache';
import { renewOnce } from '../shared/renewal';
import { BRIDGE_KEY_HEADER, bridgeKeyOf, requireBridgeKey } from '../shared/bridge-key';
import { COLLECT_RETRY_AFTER_MS, openTicket, sealTicket } from '../shared/collect';
import { collectStatus, startCollect } from './collect';
import {
  apiBase,
  authBase,
  callUpstream,
  clientCode,
  EMAIL_LOOKUP_PATH,
  LOGIN_PATH,
  VALIDATE_OTP_PATH,
  expiryFromLogin,
  extractLinkedMerchants,
  extractLoginData,
  str,
} from './client';
import { buildFonepayRequest, FONEPAY_ROUTES, ScopeError } from './routes';
import type {
  Env,
  FonepayPendingSession,
  FonepaySession,
  LoginData,
  StoredCredentials,
} from './types';

interface AppEnv {
  Bindings: Env;
  Variables: {
    session: FonepaySession;
  };
}

const app = new Hono<AppEnv>();

/** Treat a token as dead slightly early so it cannot expire mid-request. */
const EXPIRY_SKEW_MS = 15_000;
/** Re-sign-in proactively when the token has this little life left. */
const RENEW_WHEN_WITHIN_MS = 60_000;

interface Credentials {
  emailOrUsername: string;
  password: string;
  corporateCode: string;
}

interface SignInSuccess {
  kind: 'session';
  session: FonepaySession;
}

interface SignInPending {
  kind: 'otp';
  pending: FonepayPendingSession;
  hint: string;
}

interface SignInBlocked {
  kind: 'password-change' | 'corporate-selection' | 'failed';
  status: number;
  code: string;
  message: string;
  data?: unknown;
}

type SignInOutcome = SignInSuccess | SignInPending | SignInBlocked;

/* ------------------------------------------------------------------ */
/* Sign-in                                                             */
/* ------------------------------------------------------------------ */

/** Ask the gateway which corporates this identifier belongs to. */
async function lookupCorporates(
  env: Env,
  emailOrUsername: string,
): Promise<{ ok: boolean; body: unknown; message: string }> {
  const result = await callUpstream({
    baseUrl: authBase(env),
    path: EMAIL_LOOKUP_PATH,
    method: 'POST',
    body: { emailOrUsername, clientCode: clientCode(env) },
    env,
  });
  return { ok: result.ok, body: result.body, message: result.message };
}

/**
 * Exchange credentials for a session.
 *
 * Fonepay signs in in two steps: an identifier lookup that yields the corporate
 * code, then the sign-in itself. The bridge runs the lookup itself when the
 * caller does not supply a code, so a caller only needs a username and password.
 */
async function signIn(env: Env, credentials: Credentials): Promise<SignInOutcome> {
  let corporateCode = credentials.corporateCode;

  if (!corporateCode) {
    const lookup = await lookupCorporates(env, credentials.emailOrUsername);

    if (!lookup.ok) {
      return { kind: 'failed', status: 502, code: 'UPSTREAM_UNREACHABLE', message: lookup.message };
    }

    const body = lookup.body as Record<string, unknown> | null;
    if (body && body.emailExists === false) {
      return {
        kind: 'failed',
        status: 401,
        code: 'AUTH_FAILED',
        message: 'That username or email is not registered with Fonepay.',
      };
    }

    const options = Array.isArray(body?.corporateOptions)
      ? (body?.corporateOptions as Array<Record<string, unknown>>)
      : [];
    const codes = options
      .map((option) => str(option.corporateCode, str(option.code)))
      .filter(Boolean);

    if (codes.length === 0) {
      return {
        kind: 'failed',
        status: 401,
        code: 'AUTH_FAILED',
        message: 'Fonepay returned no corporate accounts for that identifier.',
      };
    }

    if (codes.length > 1) {
      return {
        kind: 'corporate-selection',
        status: 409,
        code: 'CORPORATE_SELECTION_REQUIRED',
        message:
          'This identifier belongs to more than one corporate. Send corporateCode, chosen from data.corporateOptions.',
        data: { corporateOptions: options },
      };
    }

    corporateCode = codes[0];
  }

  const result = await callUpstream({
    baseUrl: authBase(env),
    path: LOGIN_PATH,
    method: 'POST',
    body: {
      emailOrUsername: credentials.emailOrUsername,
      password: credentials.password,
      clientCode: clientCode(env),
      corporateCode,
    },
    env,
  });

  const data = extractLoginData(result.body);

  if (!result.ok && !data.accessToken && !data.tempToken) {
    // Deliberately opaque about *why*: echoing upstream text would let a caller
    // probe which identifiers exist.
    return {
      kind: 'failed',
      status: result.status === 401 ? 401 : 502,
      code: result.status === 401 ? 'AUTH_FAILED' : 'UPSTREAM_FAILED',
      message:
        result.status === 401
          ? 'Sign-in rejected by Fonepay.'
          : `Fonepay could not complete sign-in: ${result.message}`,
    };
  }

  const stored: StoredCredentials = {
    emailOrUsername: credentials.emailOrUsername,
    password: credentials.password,
  };

  // A temporary token means the account still owes an OTP step.
  if (!data.accessToken && data.tempToken) {
    const pending: FonepayPendingSession = {
      v: 1,
      provider: 'fonepay-pending',
      accessToken: data.tempToken,
      username: str(data.username, credentials.emailOrUsername),
      corporateCode,
      otpType: str(data.otpType, 'OTP'),
      credentials: stored,
      createdAt: Date.now(),
    };

    return {
      kind: 'otp',
      pending,
      hint:
        `Fonepay requires a ${pending.otpType} code for this account. ` +
        'POST /api/auth/otp with {session: <data.pendingSession>, otpCode: "123456"}.',
    };
  }

  if (data.firstLogin || data.passwordExpired) {
    return {
      kind: 'password-change',
      status: 409,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message:
        'Fonepay requires this account to change its password before the portal becomes usable. ' +
        'Sign in through the Fonepay portal once to complete that step.',
    };
  }

  if (!data.accessToken) {
    return {
      kind: 'failed',
      status: 502,
      code: 'AUTH_FAILED',
      message: 'Fonepay did not return an access token.',
    };
  }

  const signedInAt = Date.now();
  const session = buildSession({
    env,
    data,
    corporateCode,
    credentials: stored,
    signedInAt,
  });

  return { kind: 'session', session };
}

function buildSession(options: {
  env: Env;
  data: LoginData;
  corporateCode: string;
  credentials: StoredCredentials;
  signedInAt: number;
  previous?: FonepaySession;
}): FonepaySession {
  return {
    v: 1,
    provider: 'fonepay',
    accessToken: str(options.data.accessToken),
    refreshToken: str(options.data.refreshToken),
    tempToken: str(options.data.tempToken),
    accessExpiresAt: expiryFromLogin(options.data, options.signedInAt) - EXPIRY_SKEW_MS,
    signedInAt: options.signedInAt,
    username: str(options.data.username, options.credentials.emailOrUsername),
    corporateCode: options.corporateCode,
    userId: str(options.data.userId),
    displayName: str(
      options.previous?.displayName,
      str(options.data.username, options.credentials.emailOrUsername),
    ),
    otpType: str(options.data.otpType),
    linkedMerchants: options.previous?.linkedMerchants ?? [],
    credentials: options.credentials,
    renewedAt: options.previous ? options.signedInAt : undefined,
  };
}

/** Best-effort lookup of the merchants this session may read. */
async function loadLinkedMerchants(env: Env, session: FonepaySession): Promise<FonepaySession> {
  try {
    const result = await callUpstream({
      baseUrl: apiBase(env),
      path: '/corporate/api/v1/merchant-collection/linked-merchants',
      method: 'GET',
      accessToken: session.accessToken,
      env,
    });
    if (!result.ok) return session;
    const merchants = extractLinkedMerchants(result.body);
    return merchants.length > 0 ? { ...session, linkedMerchants: merchants } : session;
  } catch {
    // A missing list only costs the scope check, never the session.
    return session;
  }
}

/* ------------------------------------------------------------------ */
/* Renewal — sign in again, since Fonepay exposes no refresh endpoint   */
/* ------------------------------------------------------------------ */

function renewEnabled(env: Env): boolean {
  return env.FONEPAY_RENEW_ON_EXPIRY !== '0';
}

/**
 * Renew by signing in again with the credentials held inside the sealed session.
 *
 * Fonepay issues a `refreshToken` but its portal never exchanges one — there is
 * no refresh route anywhere in the app bundle — so re-signing in is the only way
 * to keep a session alive past its token lifetime.
 */
async function renewSession(
  env: Env,
  session: FonepaySession,
): Promise<{ session: FonepaySession; sealed: string } | null> {
  if (!renewEnabled(env)) return null;

  // Renewal here is a *real sign-in with the stored password*, so a burst of
  // concurrent requests noticing the same expiry must not become a burst of
  // password posts at a rate-limited bank endpoint. Keyed by the token being
  // renewed, in-isolate calls share one promise and other isolates reuse the
  // sealed result from the cache for the next 30 seconds.
  const sealed = await renewOnce({
    sessionToken: session.accessToken,
    cache: defaultCache(),
    renew: async () => {
      const outcome = await signIn(env, {
        emailOrUsername: session.credentials.emailOrUsername,
        password: session.credentials.password,
        corporateCode: session.corporateCode,
      });

      if (outcome.kind !== 'session') return null;

      const renewed: FonepaySession = {
        ...outcome.session,
        linkedMerchants: session.linkedMerchants,
        displayName: session.displayName,
        renewedAt: Date.now(),
      };

      return sealSession(renewed, env.SESSION_SECRET);
    },
  });

  if (!sealed) return null;

  const renewed = await openSession<FonepaySession>(sealed, env.SESSION_SECRET);
  if (!renewed || renewed.provider !== 'fonepay') return null;
  return { session: renewed, sealed };
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

// Manned door: no-op until BRIDGE_KEY is set, then every /api/* call must carry
// it. This bridge is worse than NepalPay's to leave open — the sealed session
// holds the password so it can re-sign-in.
app.use('/api/*', requireBridgeKey());

const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.env.SESSION_SECRET) return c.json(secretMissing(), 500);

  const token = bearerFrom(c);
  if (!token) {
    return c.json(
      errorBody('NO_SESSION', 'Missing session token. Call POST /api/auth/login first.'),
      401,
    );
  }

  let session = await openSession<FonepaySession>(token, c.env.SESSION_SECRET);
  if (!session || session.provider !== 'fonepay') {
    return c.json(
      errorBody('INVALID_SESSION', 'Session token is invalid or was tampered with.'),
      401,
    );
  }

  const now = Date.now();
  const expired = now >= session.accessExpiresAt;
  const dueForRenewal = now >= session.accessExpiresAt - RENEW_WHEN_WITHIN_MS;

  if (expired) {
    const renewed = await renewSession(c.env, session);
    if (!renewed) {
      return c.json(
        errorBody(
          'SESSION_EXPIRED',
          renewEnabled(c.env)
            ? 'The Fonepay token expired and re-signing in failed. Sign in again.'
            : 'The Fonepay token expired and renewal is disabled. Sign in again.',
        ),
        401,
      );
    }
    session = renewed.session;
    c.header(SESSION_HEADER, renewed.sealed);
  } else if (dueForRenewal) {
    const renewed = await renewSession(c.env, session);
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
  const emailOrUsername = str(body.emailOrUsername, str(body.username)).trim();
  const password = typeof body.password === 'string' ? body.password : '';
  const corporateCode = str(body.corporateCode).trim();

  if (!emailOrUsername || !password) {
    return c.json(
      errorBody('INVALID_REQUEST', 'Both emailOrUsername (or username) and password are required.'),
      400,
    );
  }

  let outcome: SignInOutcome;
  try {
    outcome = await signIn(c.env, { emailOrUsername, password, corporateCode });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return c.json(errorBody('UPSTREAM_UNREACHABLE', `Could not reach Fonepay: ${detail}`), 502);
  }

  if (outcome.kind !== 'session' && outcome.kind !== 'otp') {
    // A corporate-selection needs its options handed back, so the payload goes in
    // `data` rather than being buried in `errors`.
    return c.json(
      { ...errorBody(outcome.code, outcome.message), data: outcome.data ?? null },
      outcome.status as ContentfulStatusCode,
    );
  }

  if (outcome.kind === 'otp') {
    return c.json(
      {
        ...errorBody('OTP_REQUIRED', 'Fonepay requires a one-time code to finish signing in.'),
        data: {
          otpType: outcome.pending.otpType,
          pendingSession: await sealSession(outcome.pending, c.env.SESSION_SECRET),
          hint: outcome.hint,
        },
      },
      409,
    );
  }

  const session = await loadLinkedMerchants(c.env, outcome.session);
  const sealed = await sealSession(session, c.env.SESSION_SECRET);

  return c.json(
    successBody('Signed in to Fonepay.', {
      session: sealed,
      expiresAt: session.accessExpiresAt,
      autoRenew: renewEnabled(c.env),
      user: {
        username: session.username,
        corporateCode: session.corporateCode,
        userId: session.userId,
        otpType: session.otpType,
        linkedMerchants: session.linkedMerchants,
      },
    }),
  );
});

/** Resolve the corporate accounts behind an identifier, without a password. */
app.post('/api/auth/lookup', async (c) => {
  const body = await readJsonBody(c);
  const emailOrUsername = str(body.emailOrUsername, str(body.username)).trim();
  if (!emailOrUsername) {
    return c.json(errorBody('INVALID_REQUEST', 'emailOrUsername is required.'), 400);
  }

  const lookup = await lookupCorporates(c.env, emailOrUsername);
  if (!lookup.ok) {
    return c.json(errorBody('AUTH_LOOKUP_FAILED', lookup.message), 502);
  }

  return c.json(successBody('Corporate accounts for that identifier.', lookup.body));
});

/**
 * Finish a sign-in that stopped at the OTP step.
 *
 * The gateway's OTP body schema is not published, so the caller's fields are
 * forwarded as sent, and the temporary token from the pending session authorises
 * the call.
 */
app.post('/api/auth/otp', async (c) => {
  if (!c.env.SESSION_SECRET) return c.json(secretMissing(), 500);

  const body = await readJsonBody(c);
  const pendingToken = str(body.session);
  const code = str(body.otpCode, str(body.otp, str(body.code))).trim();

  if (!pendingToken || !code) {
    return c.json(
      errorBody('INVALID_REQUEST', 'Both session (the pending session) and otpCode are required.'),
      400,
    );
  }

  const pending = await openSession<FonepayPendingSession>(pendingToken, c.env.SESSION_SECRET);
  if (!pending || pending.provider !== 'fonepay-pending') {
    return c.json(errorBody('INVALID_SESSION', 'The pending session is invalid or has expired.'), 401);
  }

  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'session') forwarded[key] = value;
  }
  if (!forwarded.otpCode) forwarded.otpCode = code;

  const result = await callUpstream({
    baseUrl: authBase(c.env),
    path: VALIDATE_OTP_PATH,
    method: 'POST',
    body: forwarded,
    accessToken: pending.accessToken,
    env: c.env,
  });

  if (!result.ok) {
    return c.json(errorBody('OTP_FAILED', result.message), (result.status || 401) as ContentfulStatusCode);
  }

  const data = extractLoginData(result.body);
  const token = str(data.accessToken, str((result.body as Record<string, unknown>)?.accessToken));
  if (!token) {
    return c.json(
      errorBody('OTP_FAILED', 'Fonepay accepted the code but returned no access token.', [result.body]),
      502,
    );
  }

  const session = await loadLinkedMerchants(
    c.env,
    buildSession({
      env: c.env,
      data: { ...data, accessToken: token },
      corporateCode: pending.corporateCode,
      credentials: pending.credentials,
      signedInAt: Date.now(),
    }),
  );

  const sealed = await sealSession(session, c.env.SESSION_SECRET);

  return c.json(
    successBody('Signed in to Fonepay.', {
      session: sealed,
      expiresAt: session.accessExpiresAt,
      autoRenew: renewEnabled(c.env),
      user: {
        username: session.username,
        corporateCode: session.corporateCode,
        userId: session.userId,
        linkedMerchants: session.linkedMerchants,
      },
    }),
  );
});

/** Session identity. Safe to expose — it holds no token material. */
app.get('/api/auth/me', requireSession, (c) => {
  const session = c.get('session');
  return c.json(
    successBody('Session is active.', {
      username: session.username,
      corporateCode: session.corporateCode,
      userId: session.userId,
      displayName: session.displayName,
      otpType: session.otpType,
      linkedMerchants: session.linkedMerchants,
      expiresAt: session.accessExpiresAt,
      signedInAt: session.signedInAt,
      renewedAt: session.renewedAt ?? null,
      autoRenew: renewEnabled(c.env),
    }),
  );
});

/** Force a renewal, to prove the stored credentials still work. */
app.post('/api/auth/refresh', requireSession, async (c) => {
  if (!renewEnabled(c.env)) {
    return c.json(
      errorBody('REFRESH_NOT_CONFIGURED', 'Set FONEPAY_RENEW_ON_EXPIRY to enable renewal.'),
      501,
    );
  }

  const renewed = await renewSession(c.env, c.get('session'));
  if (!renewed) {
    return c.json(
      errorBody('REFRESH_FAILED', 'Fonepay rejected the stored credentials. Sign in again.'),
      401,
    );
  }

  return c.json(
    successBody('Session renewed by signing in again.', {
      session: renewed.sealed,
      expiresAt: renewed.session.accessExpiresAt,
      renewedAt: renewed.session.renewedAt,
    }),
  );
});

/** Sessions are stateless, so there is nothing to revoke server-side. */
app.post('/api/auth/logout', (c) =>
  c.json(successBody('Session discarded. Delete the token on the client.', null)),
);

/* ------------------------------------------------------------------ */
/* Collect — take a payment and learn when it lands                     */
/* ------------------------------------------------------------------ */

/**
 * Mint a dynamic QR for an amount and return a ticket to watch it with.
 *
 * A unique `remarks` is always written when the caller does not supply one: it is
 * the only human-readable field Fonepay's collection report echoes back, so it is
 * what makes a specific payment findable later.
 */
app.post('/api/collect', requireSession, async (c) => {
  const outcome = await startCollect({
    env: c.env,
    session: c.get('session'),
    input: await readJsonBody(c),
  });

  if (!outcome.ok) {
    return c.json(errorBody(outcome.code, outcome.message), outcome.status as ContentfulStatusCode);
  }

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
        referenceId: ticket.keys.referenceId ?? null,
        websocketId: ticket.keys.websocketId ?? null,
      },
    }),
  );
});

/** Poll a collect: PENDING while nothing has arrived, PAID once it has. */
app.get('/api/collect/:id', requireSession, async (c) => {
  const ticket = await openTicket(c.req.param('id'), c.env.SESSION_SECRET);
  if (!ticket) {
    return c.json(
      errorBody('INVALID_COLLECT', 'This collect id is invalid or was tampered with.'),
      401,
    );
  }

  if (ticket.provider !== 'fonepay') {
    return c.json(
      errorBody('WRONG_PROVIDER', 'This collect id belongs to the NepalPay bridge.'),
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

for (const spec of FONEPAY_ROUTES) {
  const handler = async (c: Context<AppEnv>) => {
    let session = c.get('session');
    // GET routes take their parameters from the query string, POST routes from the
    // body. Both end up in the same bag, so a path placeholder like `{merchantId}`
    // or `{transactionId}` can be filled either way.
    const incoming = spec.method === 'POST' ? await readJsonBody(c) : (c.req.query() ?? {});

    let request;
    try {
      request = buildFonepayRequest(session, spec, incoming);
    } catch (error) {
      if (error instanceof ScopeError) return c.json(errorBody('INVALID_REQUEST', error.message), 400);
      throw error;
    }

    const call = async (activeSession: FonepaySession) =>
      callUpstream({
        baseUrl: apiBase(c.env),
        path: `${request.path}${request.query}`,
        method: spec.method,
        body: request.body,
        accessToken: activeSession.accessToken,
        env: c.env,
      });

    // Reference routes (`cacheSeconds`) answer from an account-scoped cache —
    // which also spares them the renew-and-retry dance below on a cache hit.
    const { result, hit } = await withRefCache({
      cache: defaultCache(),
      ttlSeconds: spec.cacheSeconds,
      route: spec.path,
      scope: `${session.corporateCode}/${session.username}`,
      request: { path: request.path, query: request.query, body: request.body ?? null },
      cacheable: (r) => r.ok,
      run: async () => {
        let out = await call(session);

        // The token looked alive but the gateway disagreed: renew once and retry.
        if (out.status === 401) {
          const renewed = await renewSession(c.env, session);
          if (renewed) {
            session = renewed.session;
            c.header(SESSION_HEADER, renewed.sealed);
            out = await call(session);
          }
        }
        return out;
      },
    });
    if (hit) c.header(REF_CACHE_HEADER, 'HIT');

    if (result.status === 401) {
      return c.json(
        errorBody('SESSION_EXPIRED', 'Fonepay rejected the session. Sign in again.'),
        401,
      );
    }

    if (!result.ok) {
      return c.json(
        errorBody('UPSTREAM_FAILED', result.message, [result.raw.slice(0, 500)]),
        (result.status || 502) as ContentfulStatusCode,
      );
    }

    // Success bodies are passed through untouched — the portal's own envelope,
    // status code and all — so callers see exactly what Fonepay said.
    return c.json(result.body, result.status as ContentfulStatusCode);
  };

  if (spec.method === 'GET') app.get(`/api${spec.path}`, requireSession, handler);
  else app.post(`/api${spec.path}`, requireSession, handler);
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

app.get('/api/health', (c) =>
  c.json(
    successBody('ok', {
      provider: 'fonepay',
      api: apiBase(c.env),
      auth: authBase(c.env),
      origin: c.env.FONEPAY_ORIGIN ?? '',
      clientCode: clientCode(c.env),
      sessionSecretConfigured: Boolean(c.env.SESSION_SECRET),
      secure: {
        bridgeKeyRequired: bridgeKeyOf(c.env) !== null,
        edgeRateLimiterBound: Boolean(c.env.LOGIN_RATE_LIMITER),
        allowedOrigins: (c.env.ALLOWED_ORIGINS ?? '') || '*',
        loginRateLimitPerMinute: Number(c.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? '') || 10,
      },
      autoRenew: renewEnabled(c.env),
    }),
  ),
);

app.get('/api', (c) =>
  c.json(
    successBody('Fonepay bridge routes', {
      auth: [
        'POST /api/auth/login',
        'POST /api/auth/lookup',
        'POST /api/auth/otp',
        'GET /api/auth/me',
        'POST /api/auth/refresh',
        'POST /api/auth/logout',
      ],
      collect: [
        'POST /api/collect  { amount, remarks?, orderId?, subMerchantId?, terminalId?, expiresInSeconds? }',
        'GET /api/collect/:id  -> PENDING | PAID | EXPIRED',
      ],
      security: {
        bridgeKeyHeader: BRIDGE_KEY_HEADER,
        bridgeKeyRequired: bridgeKeyOf(c.env) !== null,
      },
      endpoints: FONEPAY_ROUTES.map((spec) => ({
        route: `${spec.method} /api${spec.path}`,
        upstream: spec.upstream,
        title: spec.title,
        params: spec.params ?? [],
        bodyKeys: spec.bodyKeys ?? [],
        defaults: spec.defaults ?? null,
      })),
      renewal: { header: SESSION_HEADER, autoRenew: renewEnabled(c.env), strategy: 'sign-in-again' },
    }),
  ),
);

app.notFound((c) =>
  c.json(errorBody('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`), 404),
);

export default app;
