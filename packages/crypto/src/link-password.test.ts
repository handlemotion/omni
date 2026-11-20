import { describe, expect, it } from "vitest";
import { hashLinkPassword, linkKeyMatches, linkPasswordMatches, signLinkKey } from "./index.ts";

describe("share link passwords", () => {
  it("matches the password it was made from and nothing else, salted each time", async () => {
    const stored = await hashLinkPassword("correct horse");
    expect(stored).not.toContain("correct horse");
    expect(await linkPasswordMatches("correct horse", stored)).toBe(true);
    expect(await linkPasswordMatches("correct hors", stored)).toBe(false);
    expect(await linkPasswordMatches("", stored)).toBe(false);
    expect(await hashLinkPassword("correct horse")).not.toBe(stored);
  });

  it("matches nothing against a malformed or tampered hash", async () => {
    const stored = await hashLinkPassword("pw");
    const [scheme, rounds, salt] = stored.split("$");
    for (const bad of ["", "pw", `${scheme}$${rounds}$${salt}$`, `${scheme}$0$${salt}$AAAA`]) {
      expect(await linkPasswordMatches("pw", bad)).toBe(false);
    }
  });
});

describe("unlock keys", () => {
  const secret = "s".repeat(32);
  const link = { shareId: "abc", passwordHash: "pbkdf2-sha256$1$x$y" };
  const soon = new Date(Date.now() + 60_000);

  it("opens the link it was signed for until it expires", async () => {
    const key = await signLinkKey(secret, link, soon);
    expect(await linkKeyMatches(secret, link, key)).toBe(true);
    expect(await linkKeyMatches(secret, link, key, new Date(soon.getTime() + 1))).toBe(false);
  });

  it("stops opening after a new password, on another link, under another secret, or edited", async () => {
    const key = await signLinkKey(secret, link, soon);
    expect(await linkKeyMatches(secret, { ...link, passwordHash: "other" }, key)).toBe(false);
    expect(await linkKeyMatches(secret, { ...link, shareId: "abd" }, key)).toBe(false);
    expect(await linkKeyMatches("t".repeat(32), link, key)).toBe(false);
    const [, mac] = key.split(".");
    const later = String(soon.getTime() + 86_400_000);
    expect(await linkKeyMatches(secret, link, `${later}.${mac}`)).toBe(false);
  });
});
