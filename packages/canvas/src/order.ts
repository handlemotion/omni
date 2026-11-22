import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * `count` fractional keys for z-order, in order, after `before` and before `after` (`null` for no
 * bound): strings that sort between the two, so moving one element never rewrites anyone else's
 * key, and that stay short however many are added at the end.
 */
export const keysBetween = (before: string | null, after: string | null, count: number) =>
  generateNKeysBetween(before, after, count);

/** Whether `key` is a z-order key this package makes (a newer or broken client's may not be). */
export function isKey(key: string) {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** Orders by key, then by id, so equal keys made at once still sort the same everywhere. */
export const byKey = (a: { z: string; id: string }, b: { z: string; id: string }) =>
  a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
