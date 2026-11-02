import { expect, test } from "vitest";
import { deterministicMessageId } from "./index.ts";

// Vectors from the mail service's original `node:crypto` implementation. The Worker returns this
// value to the app and the mail service stamps it on the sent mail; if the two ever compute it
// differently, the app never matches its pending bubble to the synced message.
test("matches the mail service's original Message-ID derivation, byte for byte", async () => {
  expect(await deterministicMessageId("mem_01:reply-partnership-1:send", "hello@hooli.test")).toBe(
    "<38cccd66278ec80fc4061e3d80813d0f@hooli.test>",
  );
  // Non-ASCII keys hash as UTF-8; the domain keeps its case.
  expect(await deterministicMessageId("clé-ü:send", "Ana@Sub.Example.org")).toBe(
    "<d5bde1f459f479028be9ce3ff9d63940@Sub.Example.org>",
  );
});

test("an address without a domain is refused rather than producing `<hash@>`", async () => {
  await expect(deterministicMessageId("k", "no-domain")).rejects.toThrow(TypeError);
  await expect(deterministicMessageId("k", "trailing@")).rejects.toThrow(TypeError);
});
