import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/security/rateLimit.js';

describe('RateLimiter', () => {
  it('allows up to the maximum, then reports the wait', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 10_000, () => now);
    expect([limiter.consume('a'), limiter.consume('a'), limiter.consume('a')]).toEqual([0, 0, 0]);
    expect(limiter.consume('a')).toBe(10);
    now = 4_000;
    expect(limiter.consume('a')).toBe(6);
  });

  it('opens a fresh window after it expires', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.consume('a')).toBe(0);
    expect(limiter.consume('a')).toBeGreaterThan(0);
    now = 1_000;
    expect(limiter.consume('a')).toBe(0);
  });

  it('counts keys separately', () => {
    const limiter = new RateLimiter(1, 1_000, () => 0);
    expect(limiter.consume('a')).toBe(0);
    expect(limiter.consume('b')).toBe(0);
    expect(limiter.consume('a')).toBeGreaterThan(0);
  });
});
