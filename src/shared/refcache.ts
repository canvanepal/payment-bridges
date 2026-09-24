/**
 * Memoization for reference routes — the handful of endpoints whose answer is
 * lookup data (bank names, refund reasons, role names, filter trees) rather than
 * anything that changes minute to minute.
 *
 * A `cacheSeconds` on a route spec opts it in. The upstream result is stored
 * under a key made of the bridge path plus a SHA-256 of the account scope and
 * the fully built request, so:
 *
 *   - callers sharing one merchant share one upstream call for the TTL,
 *   - a different merchant — or a different request body — hashes elsewhere and
 *     never sees another account's answer (the scope itself is hashed, so no
 *     identifier is stored in the key),
 *   - failures are never stored: only results the caller declares cacheable
 *     (2xx, in practice) are written.
 *
 * Best-effort like the rest of the cache layer: no cache, a throwing cache, or
 * an early eviction costs exactly one extra upstream call, never a failed
 * request. Hits are announced with an `X-Bridge-Cache: HIT` response header.
 */
import { cacheGet, cachePut, hashKey, type JsonCache } from './kvcache';

export interface RefCacheOptions<T> {
  /** Cache to use — `defaultCache()` in the Workers, injected in tests. */
  cache: JsonCache | null;
  /** Time-to-live in seconds. Falsy means "never cache this route". */
  ttlSeconds?: number;
  /** Bridge path of the route, e.g. `/banks`. */
  route: string;
  /** Account scope (merchant code, corporate code + user) — hashed, never stored raw. */
  scope: string;
  /** The fully built upstream request, so two different inputs never collide. */
  request: unknown;
  /** True when this result is a success worth storing. */
  cacheable: (result: T) => boolean;
  /** Performs the upstream call when nothing is cached. */
  run: () => Promise<T>;
}

/** Response header set on a served-from-cache answer. */
export const REF_CACHE_HEADER = 'X-Bridge-Cache';

export async function withRefCache<T>(
  options: RefCacheOptions<T>,
): Promise<{ result: T; hit: boolean }> {
  const { cache, ttlSeconds, route, scope, request } = options;

  if (!cache || !ttlSeconds) return { result: await options.run(), hit: false };

  const discriminator = await hashKey(JSON.stringify([scope, request ?? null]));
  const key = `ref/${route}/${discriminator}`;

  const stored = await cacheGet<T>(cache, key);
  if (stored !== null) return { result: stored, hit: true };

  const result = await options.run();
  if (options.cacheable(result)) await cachePut(cache, key, result, ttlSeconds);
  return { result, hit: false };
}
