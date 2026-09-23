/**
 * Best-effort per-isolate sign-in throttle.
 *
 * Cloudflare runs many isolates, so this is not a global limit — it only blunts
 * a burst that lands on one instance. Put a WAF rate-limiting rule in front of
 * the login route for a real one.
 */
const attempts = new Map<string, number[]>();

export function isRateLimited(ip: string, limitPerMinute: number): boolean {
  const windowStart = Date.now() - 60_000;
  const hits = (attempts.get(ip) ?? []).filter((at) => at > windowStart);

  if (hits.length >= limitPerMinute) {
    attempts.set(ip, hits);
    return true;
  }

  hits.push(Date.now());
  attempts.set(ip, hits);
  if (attempts.size > 10_000) attempts.clear();
  return false;
}
