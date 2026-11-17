import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { automatedKind } from "./automated.ts";
import { parseMessage } from "./parse.ts";
import { decideThread } from "./thread.ts";

const parse = async (name: string) =>
  (await parseMessage(readFileSync(new URL(`../../../fixtures/eml/${name}`, import.meta.url))))
    .message;

const lookup = (headers: Record<string, string>) => (name: string) => headers[name] ?? null;

describe("fixtures", () => {
  test.each([
    ["auto-reply-outlook-out-of-office.eml", "auto-reply"],
    ["auto-reply-gmail-vacation.eml", "auto-reply"],
    ["auto-reply-legacy-headers.eml", "auto-reply"],
    ["bounce-dsn-postfix.eml", "bounce"],
    ["bounce-exim-plain.eml", "bounce"],
  ])("%s is %s", async (name, kind) => {
    expect((await parse(name)).automated?.kind).toBe(kind);
  });

  test.each([
    "outlook-mobile-reply.eml",
    "outlook-desktop-reply-spanish.eml",
    "ios-mail-reply.eml",
    "gmail-reply-html-only.eml",
    "encoded-word-headers.eml",
    "newsletter-html-only.eml",
  ])("%s was written by a person", async (name) => {
    expect((await parse(name)).automated).toBeNull();
  });

  test.each([
    ["bounce-dsn-postfix.eml", "<3a9f1c7e-5b2d-4e8a-9c6f-0d4b2e8a1c37@example.com>"],
    ["bounce-exim-plain.eml", "<b6d2e8f4-1a3c-4b7e-9f5d-2c8a6e4b0d19@example.com>"],
  ])("%s names the message that bounced", async (name, id) => {
    expect((await parse(name)).automated?.bouncedMessageId).toBe(id);
  });
});

describe("automatedKind", () => {
  test("an explicit no is a person, and parameters after the value are ignored", () => {
    expect(automatedKind(lookup({ "auto-submitted": "no" }), null)).toBeNull();
    expect(automatedKind(lookup({ "x-autoreply": "no" }), null)).toBeNull();
    expect(
      automatedKind(lookup({ "auto-submitted": "auto-replied; owner-email=a@example.com" }), null),
    ).toBe("auto-reply");
  });

  test("system notices are auto-generated, not auto-replies", () => {
    expect(automatedKind(lookup({ "auto-submitted": "auto-generated" }), null)).toBe(
      "auto-generated",
    );
  });

  test("a delivery report is a bounce whoever sends it; a read receipt is an auto-reply", () => {
    const report = (type: string) =>
      lookup({ "content-type": `multipart/report; report-type="${type}"; boundary="b"` });
    expect(automatedKind(report("delivery-status"), "postmaster@example.net")).toBe("bounce");
    expect(automatedKind(report("disposition-notification"), "ana@example.net")).toBe("auto-reply");
  });
});

test("a bounce joins the conversation of the message it returns", async () => {
  const bounce = await parse("bounce-dsn-postfix.eml");
  expect(bounce.inReplyTo).toBe("<3a9f1c7e-5b2d-4e8a-9c6f-0d4b2e8a1c37@example.com>");
  const knownMessageIds = new Map([
    ["<3a9f1c7e-5b2d-4e8a-9c6f-0d4b2e8a1c37@example.com>", "t-quote"],
  ]);
  expect(
    decideThread(bounce, {
      knownMessageIds,
      candidates: [],
      selfAddresses: ["support@example.com"],
    }),
  ).toEqual({ kind: "headers", threadId: "t-quote" });
});
