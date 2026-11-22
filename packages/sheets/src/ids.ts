import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const UNBIASED = 256 - (256 % ALPHABET.length);

const random = (n: number) => {
  let out = "";
  while (out.length < n) {
    for (const byte of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (byte < UNBIASED && out.length < n) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
};

/** A new id, `prefix` and six random characters, not in `taken`. */
export function newId(prefix: "t" | "r" | "c" | "v", taken?: { has(id: string): boolean }) {
  for (;;) {
    const id = prefix + random(6);
    if (!taken?.has(id)) return id;
  }
}

const JITTER_STEPS = 6;

/**
 * A position between `a` and `b` (either may be null for an end), jittered by a short random walk
 * so that two peers inserting between the same neighbours almost never make the same key.
 * `a` must sort before `b`.
 */
export function positionBetween(a: string | null, b: string | null) {
  let low = a;
  let high = b;
  let key = generateKeyBetween(low, high);
  for (let step = 0; step < JITTER_STEPS; step++) {
    const coin = crypto.getRandomValues(new Uint8Array(1))[0]! & 1;
    if (coin) low = key;
    else high = key;
    key = generateKeyBetween(low, high);
  }
  return key;
}

/** `n` positions in order between `a` and `b`, evenly spread. */
export const positionsBetween = (a: string | null, b: string | null, n: number) =>
  generateNKeysBetween(a, b, n);

/** Orders by position, then by id. */
export const byPosition = (x: { p: string; id: string }, y: { p: string; id: string }) =>
  x.p < y.p ? -1 : x.p > y.p ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
