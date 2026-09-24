/**
 * Tiny JSON cache over the Cache API.
 *
 * Used for two things that are both "the same answer for a few seconds": the
 * sealed result of a renewal, so a burst of requests collapses into one upstream
 * sign-in, and the verdict of a payment poll, so several watchers of one collect
 * do not each hammer the bank's report endpoint.
 *
 * Everything is best-effort. A cache that throws, is missing, or evicts early
 * costs an extra upstream call — never a failed request.
 */

/** Structural subset of the Cache API this module needs. */
export interface JsonCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Synthetic origin for cache keys. It is never fetched, only matched. */
const CACHE_ORIGIN = 'https://cache.bridge.internal';

/**
 * The zone's default cache, when the runtime has one.
 *
 * `caches` is absent under `node` (the unit tests) and can be absent in other
 * runtimes, so this is probed rather than assumed.
 */
export function defaultCache(): JsonCache | null {
  const holder = globalThis as unknown as { caches?: { default?: JsonCache } };
  return holder.caches?.default ?? null;
}

export function cacheRequest(key: string): Request {
  return new Request(`${CACHE_ORIGIN}/${key}`);
}

export async function cacheGet<T>(cache: JsonCache | null, key: string): Promise<T | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheRequest(key));
    if (!hit) return null;
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

export async function cachePut(
  cache: JsonCache | null,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(
      cacheRequest(key),
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` },
      }),
    );
  } catch {
    // Ignored on purpose: a missed cache write only costs one extra upstream call.
  }
}

/** Stable, collision-resistant cache key for a secret string. */
export async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Collapse concurrent identical work into one call.
 *
 * `run` is only invoked when nothing is cached and nothing equivalent is already
 * running in this isolate; its result is cached for `ttlSeconds` and shared with
 * every simultaneous caller.
 */
export function inFlightOnce<T>(
  registry: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const running = registry.get(key);
  if (running) return running;

  const attempt = (async () => {
    try {
      return await run();
    } finally {
      registry.delete(key);
    }
  })();

  registry.set(key, attempt);
  return attempt;
}
