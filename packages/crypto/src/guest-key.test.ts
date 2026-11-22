import { describe, expect, it } from "vitest";
import { guestOfKey, signGuestKey } from "./index.ts";

const secret = "s".repeat(32);
const soon = new Date(Date.now() + 60_000);
describe("guest keys", () => {
  it("names the guest it was made for, on its link, until it expires", async () => {
    const { guestId, key } = await signGuestKey(secret, "abc", soon);
    expect(guestId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await guestOfKey(secret, "abc", key)).toBe(guestId);
    expect(await guestOfKey(secret, "abc", key, new Date(soon.getTime() + 1))).toBeNull();
  });

  it("names nobody on another link, under another secret, or edited", async () => {
    const { key } = await signGuestKey(secret, "abc", soon);
    expect(await guestOfKey(secret, "abd", key)).toBeNull();
    expect(await guestOfKey("t".repeat(32), "abc", key)).toBeNull();
    const [, until, mac] = key.split(".");
    const other = (await signGuestKey(secret, "abc", soon)).guestId;
    expect(await guestOfKey(secret, "abc", `${other}.${until}.${mac}`)).toBeNull();
    expect(await guestOfKey(secret, "abc", `${key}.x`)).toBeNull();
    expect(await guestOfKey(secret, "abc", "")).toBeNull();
  });

  it("keeps a guest's id when the key is renewed", async () => {
    const { guestId } = await signGuestKey(secret, "abc", soon);
    const renewed = await signGuestKey(secret, "abc", new Date(soon.getTime() + 60_000), guestId);
    expect(await guestOfKey(secret, "abc", renewed.key)).toBe(guestId);
  });
});
