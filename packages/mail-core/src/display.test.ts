import { expect, test } from "vitest";
import { addedParticipants, messageDisplay } from "./display";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" \n ");

test("messageDisplay turns a message into a card past about 120 words, counting words not lines", () => {
  expect(messageDisplay(words(120))).toBe("bubble");
  expect(messageDisplay(words(121))).toBe("card");
  expect(messageDisplay(`${"\n".repeat(500)}ok thanks`)).toBe("bubble");
});

test("addedParticipants announces a person once, against the whole thread, ignoring case", () => {
  const ana = { name: "Ana", address: "ana@example.com" };
  const luis = { name: "Luis", address: "luis@example.com" };
  const bea = { name: "Bea", address: "bea@example.com" };
  const added = addedParticipants([
    { fromAddress: "ana@example.com", to: [luis], cc: [] },
    // Luis replies to Ana only: Luis was on the first message, so nobody is added.
    { fromAddress: "luis@example.com", to: [ana], cc: [] },
    // Ana adds Bea, and re-includes Luis (seen two messages back, upper-cased here).
    { fromAddress: "Ana@Example.com", to: [{ ...luis, address: "LUIS@example.com" }], cc: [bea] },
    { fromAddress: "bea@example.com", to: [ana, luis], cc: [] },
  ]);
  expect(added).toEqual([[], [], [bea], []]);
});
