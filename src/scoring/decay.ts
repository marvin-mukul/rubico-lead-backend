/**
 * Exponential decay by half-life. Pure — no config lookups, no I/O.
 *
 * §12 pins three properties of this function, because a silent decay bug
 * survives to the Day-30 review and makes the whole engine look broken:
 *   decay at t=0 equals the base weight
 *   decay at one half-life equals half the base weight
 *   a 180-day funding signal contributes < 1
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole and fractional days between two instants. Never negative. */
export function ageInDays(eventDate: Date, now: Date): number {
  return Math.max(0, (now.getTime() - eventDate.getTime()) / MS_PER_DAY);
}

/**
 * `weight * 0.5 ^ (ageDays / halfLifeDays)`.
 *
 * A non-positive half-life means "does not decay" rather than dividing by
 * zero — a misconfigured half-life should hold a signal steady, not produce
 * NaN and poison every score that touches it.
 */
export function decay(weight: number, halfLifeDays: number, ageDays: number): number {
  if (!Number.isFinite(weight)) return 0;
  if (halfLifeDays <= 0 || !Number.isFinite(halfLifeDays)) return weight;
  const age = Math.max(0, ageDays);
  return weight * Math.pow(0.5, age / halfLifeDays);
}

/** Convenience: decay a weight given the event date and the clock. */
export function decayAt(
  weight: number,
  halfLifeDays: number,
  eventDate: Date,
  now: Date,
): number {
  return decay(weight, halfLifeDays, ageInDays(eventDate, now));
}
