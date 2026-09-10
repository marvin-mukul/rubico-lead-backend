import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison (§8.1).
 *
 * Both inputs are hashed to a fixed-width digest before comparing, so the
 * comparison is constant-time *and* independent of input length. An early
 * `a.length !== b.length` return would be simpler, but it leaks the secret's
 * length through timing — exactly what this is meant to prevent.
 */
export function safeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
