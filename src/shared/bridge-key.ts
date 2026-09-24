import { createMiddleware } from 'hono/factory';
import { errorBody } from './errors';

/**
 * Header carrying the bridge's own shared secret.
 *
 * Deliberately *not* `Authorization`: that header already carries the session
 * token, and a caller should never mix the two up.
 */
export const BRIDGE_KEY_HEADER = 'X-Bridge-Key';

export interface BridgeKeyEnv {
  /** Shared secret every caller must present. Unset means the bridge is open. */
  BRIDGE_KEY?: string;
}

/** Read the configured key, treating blank as unset. */
export function bridgeKeyOf(env: { BRIDGE_KEY?: string }): string | null {
  const key = env.BRIDGE_KEY?.trim();
  return key ? key : null;
}

/**
 * Compare two secrets without leaking their length or content through timing.
 *
 * Workers has no `timingSafeEqual`, so this walks fixed-length byte strings and
 * accumulates the difference — the early exit is only on length.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * Require `X-Bridge-Key` on every `/api/*` call when `BRIDGE_KEY` is set.
 *
 * With the key unset the bridge answers anyone, which is the right default while
 * wiring a site up and the wrong one afterwards: an open bridge is a credential
 * relay into a payment portal. Set it and only your own callers get through.
 */
export function requireBridgeKey(headerName = BRIDGE_KEY_HEADER) {
  return createMiddleware(async (c, next) => {
    const expected = bridgeKeyOf(c.env as BridgeKeyEnv);
    if (!expected) return next();

    const presented = c.req.header(headerName)?.trim() ?? '';
    if (!presented) {
      return c.json(
        errorBody(
          'BRIDGE_KEY_REQUIRED',
          `This bridge is closed. Send the shared secret in the ${headerName} header.`,
        ),
        401,
      );
    }

    if (!secretsMatch(presented, expected)) {
      return c.json(
        errorBody('BRIDGE_KEY_INVALID', `The ${headerName} header does not match this bridge.`),
        401,
      );
    }

    return next();
  });
}
