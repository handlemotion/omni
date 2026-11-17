import { describe, expect, it } from "vitest";
import { challengeMatches, hashChallenge, newChallenge } from "./index.ts";

describe("domain challenges", () => {
  it("verifies the published value against its stored hash", async () => {
    const { value, hash } = await newChallenge();
    expect(value).toMatch(/^omni-challenge=[\w-]{43}$/);
    expect(hash).not.toContain(value.slice("omni-challenge=".length));
    expect(await challengeMatches(["v=spf1 -all", value], hash)).toBe(true);
    expect(await challengeMatches([` ${value}\n`], hash)).toBe(true);
  });

  it("refuses another claim's value, a truncated value, and the hash itself", async () => {
    const mine = await newChallenge();
    const theirs = await newChallenge();
    expect(await challengeMatches([theirs.value], mine.hash)).toBe(false);
    expect(await challengeMatches([mine.value.slice(0, -1)], mine.hash)).toBe(false);
    expect(await challengeMatches([mine.hash, `omni-challenge=${mine.hash}`], mine.hash)).toBe(
      false,
    );
    expect(await challengeMatches([], mine.hash)).toBe(false);
  });

  it("hashes plain SHA-256 of the trimmed value, so stored hashes keep verifying", async () => {
    expect(await hashChallenge(" omni-challenge=abc ")).toBe(
      "62e2d19d4223bde0e37d706028c8aa058ca57862438150d361a218b455d8b112",
    );
  });
});
