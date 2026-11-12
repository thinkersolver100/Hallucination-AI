interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window limiter held in memory: per process, resets on restart. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when the request is allowed, otherwise the seconds to wait. */
  consume(key: string): number {
    const t = this.now();
    if (this.buckets.size > 10_000) this.purge(t);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.max) return Math.ceil((bucket.resetAt - t) / 1000);
    bucket.count += 1;
    return 0;
  }

  private purge(t: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= t) this.buckets.delete(key);
  }
}
