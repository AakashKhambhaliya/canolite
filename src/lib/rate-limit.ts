/**
 * In-process rate limiting for credential endpoints.
 *
 * Canolite is a single-admin, self-hosted app with one Node process, so an
 * in-memory counter is the right size for the job — no Redis dependency, and
 * the queue/worker split doesn't serve HTTP. State is deliberately NOT
 * persisted: a restart clearing the counters is acceptable, because the
 * attacker doesn't get to trigger restarts.
 *
 * Two buckets are checked together on every attempt:
 *
 *  - per-client (best-effort IP), so one attacker is locked out on their own
 *  - global, so a distributed spray across many source IPs still hits a wall
 *    before it can grind through a password
 *
 * A successful login clears the client's bucket, so a legitimate operator who
 * fat-fingers their password a few times isn't punished afterwards.
 */

export interface RateLimitConfig {
  /** Failures allowed inside the window before the caller is locked out. */
  limit: number;
  /** Sliding window / lockout duration, in ms. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may try again (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  failures: number;
  /** Timestamp after which the bucket resets. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Cap the map so a spray across spoofed XFF values can't grow it unbounded. */
const MAX_BUCKETS = 10_000;

function getBucket(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) return existing;
  const fresh: Bucket = { failures: 0, resetAt: 0 };
  buckets.set(key, fresh);
  return fresh;
}

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still oversized after dropping the expired entries (an active flood):
  // drop the oldest-expiring half rather than letting the map grow forever.
  if (buckets.size > MAX_BUCKETS) {
    const byExpiry = [...buckets.entries()].sort(
      (a, b) => a[1].resetAt - b[1].resetAt
    );
    for (const [key] of byExpiry.slice(0, Math.floor(byExpiry.length / 2))) {
      buckets.delete(key);
    }
  }
}

/** Whether `key` is currently locked out — does NOT record an attempt. */
export function checkRateLimit(
  key: string,
  cfg: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now || bucket.failures < cfg.limit) {
    return { allowed: true, retryAfterSec: 0 };
  }
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/** Record a failed attempt against `key` and report the resulting state. */
export function recordFailure(
  key: string,
  cfg: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) sweep(now);

  const bucket = getBucket(key, now);
  bucket.failures += 1;
  // Each failure re-arms the full window, so a patient attacker trickling
  // guesses at the limit never gets a free slot back.
  bucket.resetAt = now + cfg.windowMs;
  return checkRateLimit(key, cfg);
}

/** Clear a key's failures (call after a successful authentication). */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Best-effort client identity for rate limiting.
 *
 * X-Forwarded-For is spoofable when the app is exposed directly, which is why
 * it is only ever ONE of the two buckets the login route checks — the global
 * bucket is the backstop for exactly that case. Behind the reverse proxy this
 * app is normally deployed under, the leftmost entry is the real client.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0].trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  return ip.slice(0, 64);
}

/** Reset all buckets. Test-only hook. */
export function __resetRateLimits(): void {
  buckets.clear();
}
