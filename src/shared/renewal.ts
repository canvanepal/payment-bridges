/**
 * Renewal de-duplication.
 *
 * Sessions are stateless, so nothing stops ten requests that arrive at once from
 * ten different in-flight handlers each noticing the same near-expiry token and
 * each performing its own upstream renewal. Against a bank endpoint that is both
 * wasteful and rude — every one of those calls is a real sign-in.
 *
 * Two layers fix it without any new infrastructure:
 *
 * 1. An in-isolate map of in-flight renewals, so a burst handled by one isolate
 *    collapses into a single upstream call.
 * 2. A short-lived Cache API entry holding the sealed result, so isolates that
 *    did not see the burst reuse it instead of signing in again.
 *
 * The cache key is a hash of the caller's own session token, so an entry is only
 * reachable by someone already holding that token.
 */

import { cacheGet, cachePut, hashKey, inFlightOnce, type JsonCache } from './kvcache';

/** How long a renewed session is shared. Long enough to absorb a burst. */
const DEFAULT_TTL_SECONDS = 30;

const inFlight = new Map<string, Promise<string | null>>();

/** Cache key for a session token, from its hash. */
export function renewalKey(tokenHash: string): string {
  return `renewal/${tokenHash}`;
}

export interface RenewOnceOptions {
  /** The session token whose renewal is being de-duplicated. */
  sessionToken: string;
  /** Performs the actual renewal; returns the freshly sealed session. */
  renew: () => Promise<string | null>;
  /** The zone's default cache, when available. */
  cache?: JsonCache | null;
  ttlSeconds?: number;
}

/**
 * Renew once, no matter how many callers ask at the same time.
 *
 * `renew` returns the freshly sealed session, or null when renewal is not
 * possible — in which case nothing is cached and every caller gets null.
 */
export async function renewOnce(options: RenewOnceOptions): Promise<string | null> {
  const key = renewalKey(await hashKey(options.sessionToken));
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const shared = await cacheGet<{ sealed?: unknown }>(options.cache ?? null, key);
  if (shared && typeof shared.sealed === 'string' && shared.sealed) return shared.sealed;

  return inFlightOnce(inFlight, key, async () => {
    const sealed = await options.renew();
    if (sealed) await cachePut(options.cache ?? null, key, { sealed }, ttl);
    return sealed;
  });
}

/** Test seam: forget every in-flight renewal. */
export function resetRenewals(): void {
  inFlight.clear();
}
