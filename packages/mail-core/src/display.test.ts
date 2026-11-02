import { describe, expect, test } from "vitest";
import { addedParticipants, messageDisplay, type DisplayMessage } from "./display.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const msg = (fromAddress: string, to: string[], cc: string[] = []): DisplayMessage => ({
  fromAddress,
  to: to.map((address) => ({ name: null, address })),
  cc: cc.map((address) => ({ name: null, address })),
});

describe("messageDisplay", () => {
  // The spec's line is "over about 120 words": an off-by-one or counting characters instead of
  // words turns ordinary replies into cards or long letters into bubbles.
  test("over 120 words is a card; 120 or fewer, in any whitespace, is a bubble", () => {
    expect(messageDisplay(words(120))).toBe("bubble");
    expect(messageDisplay(words(121))).toBe("card");
    expect(messageDisplay(` ${words(120).replaceAll(" ", "\n\n\t ")} `)).toBe("bubble");
    expect(messageDisplay("")).toBe("bubble");
  });
});

describe("addedParticipants", () => {
  // Catches a "someone added X" line for people who were there all along (case differences,
  // earlier senders, the mailbox itself) and lines missing for people who really joined.
  test("names only addresses new to the thread, case-insensitively, once each", () => {
    const thread = [
      msg("ana@client.test", ["hello@acme.test"], ["marta@client.test"]),
      // Reply from us: Ana and Marta were already there; nobody new.
      msg("Hello@Acme.test", ["ANA@client.test"], ["Marta@Client.test"]),
      // Ana brings in Luis (on To and Cc) and copies the mailbox under another case.
      msg("ana@client.test", ["HELLO@acme.test", "luis@client.test"], ["luis@client.test"]),
      // Luis answers and copies himself; he is not "added" again.
      msg("luis@client.test", ["ana@client.test"], ["luis@client.test"]),
    ];
    expect(addedParticipants(thread, "hello@acme.test")).toEqual([
      [],
      [],
      [{ name: null, address: "luis@client.test" }],
      [],
    ]);
  });

  test("the first message adds nobody, and a recipient who wrote earlier is not added", () => {
    const thread = [
      msg("bea@client.test", ["hello@acme.test", "carl@client.test"]),
      msg("dan@client.test", ["hello@acme.test"]),
      msg("hello@acme.test", ["dan@client.test", "bea@client.test", "eve@client.test"]),
    ];
    expect(addedParticipants(thread, "hello@acme.test")).toEqual([
      [],
      [],
      [{ name: null, address: "eve@client.test" }],
    ]);
  });
});
