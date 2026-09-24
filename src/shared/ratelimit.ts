/**
 * Sign-in throttling.
 *
 * Two layers, because they fail differently:
 *
 * 1. The platform's Rate Limiting binding, when configured (`ratelimits` in the
 *    wrangler config). It counts per key across the whole edge, which is what
 *    actually stops a distributed attempt on the login route.
 * 2. An in-isolate counter, always present. It only blunts a burst that lands on
 *    one instance, so it is a fallback rather than a defence — but it keeps local
 *    `wrangler dev` and an unconfigured deploy honest.
 */

/** Shape of the Workers Rate Limiting binding. */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitEnv {
  /** Optional binding; configured via `ratelimits` in wrangler.jsonc. */
  LOGIN_RATE_LIMITER?: RateLimiterBinding;
}

/** Per-isolate attempt log, keyed by caller identity. */
const attempts = new Map<string, number[]>();

function windowed(key: string, limitPerMinute: number): boolean {
  const windowStart = Date.now() - 60_000;
  const hits = (attempts.get(key) ?? []).filter((at) => at > windowStart);

  if (hits.length >= limitPerMinute) {
    attempts.set(key, hits);
    return true;
  }

  hits.push(Date.now());
  attempts.set(key, hits);
  if (attempts.size > 10_000) attempts.clear();
  return false;
}

/** In-isolate check only. Synchronous, always available. */
export function isRateLimited(key: string, limitPerMinute: number): boolean {
  return windowed(key, limitPerMinute);
}

/**
 * Check both layers.
 *
 * The platform limiter is authoritative when configured; if it throws (an
 * unbound or unavailable binding) the in-isolate counter still applies, so a
 * failure here never removes the throttle entirely.
 */
export async function checkRateLimit(
  env: RateLimitEnv,
  key: string,
  limitPerMinute: number,
): Promise<boolean> {
  const limiter = env.LOGIN_RATE_LIMITER;
  if (limiter) {
    try {
      const verdict = await limiter.limit({ key });
      if (verdict && verdict.success === false) return true;
      return false;
    } catch {
      // Fall through to the local counter rather than failing open.
    }
  }

  return windowed(key, limitPerMinute);
}

/** Test seam: forget every recorded attempt. */
export function resetRateLimit(): void {
  attempts.clear();
}
