// The helpdesk reopens a conversation and starts its SLA on customer mail. A machine reply
// that slips through reopens every resolved ticket an out-of-office answers; a person's
// mail marked as automated is a customer the team never hears.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { automatedKind } from "./automated.ts";
import { parseMessage } from "./parse.ts";
import { decideThread } from "./thread.ts";

const parse = async (name: string) =>
  (await parseMessage(readFileSync(new URL(`../../../fixtures/eml/${name}`, import.meta.url))))
    .message;

const lookup =
  (headers: Record<string, string>) =>
  (name: string): string | null =>
    headers[name] ?? null;

describe("fixtures", () => {
  test.each([
    ["auto-reply-outlook-out-of-office.eml", "auto-reply"],
    // Gmail sends vacation replies with Precedence: bulk; that must not read as a newsletter.
    ["auto-reply-gmail-vacation.eml", "auto-reply"],
    // No Auto-Submitted at all: only the legacy X-Autorespond and Precedence headers.
    ["auto-reply-legacy-headers.eml", "auto-reply"],
    // Both bounces also say Auto-Submitted: auto-replied; they are still bounces.
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
    // Precedence: bulk alone is a newsletter, which triage handles; it is not a machine reply.
    "newsletter-html-only.eml",
  ])("%s was written by a person", async (name) => {
    expect((await parse(name)).automated).toBeNull();
  });

  test.each([
    // RFC 3462: the original's headers travel as a text/rfc822-headers part.
    ["bounce-dsn-postfix.eml", "<3a9f1c7e-5b2d-4e8a-9c6f-0d4b2e8a1c37@example.com>"],
    // Exim pastes the original under the report, in the body.
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
    // Exchange sends NDRs from postmaster@ with no Auto-Submitted header.
    const report = (type: string) =>
      lookup({ "content-type": `multipart/report; report-type="${type}"; boundary="b"` });
    expect(automatedKind(report("delivery-status"), "postmaster@example.net")).toBe("bounce");
    expect(automatedKind(report("disposition-notification"), "ana@example.net")).toBe("auto-reply");
  });
});

test("a bounce joins the conversation of the message it returns", async () => {
  // Delivery reports carry no In-Reply-To, so without this a bounce opens a new ticket.
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
