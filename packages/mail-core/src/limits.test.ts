// Hostile and oversized input: every case here hung the worker for seconds, threw, or
// produced data Postgres rejects before the limits it tests were added. Time budgets are
// about 20x what each case takes now and far below what it took before.
import { describe, expect, test } from "vitest";
import {
  cleanMessage,
  htmlToPlainText,
  isLongForm,
  MAX_HTML_LENGTH,
  sanitizeHtml,
  stripQuotedHtml,
} from "./html";
import { displayNameSpoof, parseMessage } from "./parse";
import { stripReply } from "./reply";

const options = {
  proxyUrl: (src: string) => `https://img.omni.test/p?u=${encodeURIComponent(src)}`,
  cidUrl: () => null,
};

function elapsedMs(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("no catastrophic backtracking", () => {
  // Each line is shaped to make one of the reply-header or signature patterns backtrack:
  // an opening word that matches, then a long tail that never completes the pattern.
  // "abc. x skrev x" lines took 19 s for 2,000 lines in email-reply-parser.
  test.each([
    ["Scandinavian header", "abc. x skrev x\n".repeat(4000)],
    ["English header", `On ${"a ".repeat(240)}\n`.repeat(400)],
    ["German header", `Am ${"x ".repeat(240)}schrieb\n`.repeat(400)],
    ["Polish header", `W dniu ${"x ".repeat(240)}\n`.repeat(400)],
    ["From header", `From:${" <".repeat(240)}\n`.repeat(400)],
    ["date header", `30.10.2026 ${"1".repeat(480)}\n`.repeat(400)],
    ["on/at/wrote header", `x on ${" at ".repeat(120)} wrote\n`.repeat(400)],
    ["signature", `Gesendet von ${" für ".repeat(80)}\n`.repeat(400)],
    ["one huge line", `On ${"a ".repeat(100_000)}`],
    ["blank lines", `hi\n${"\n".repeat(100_000)}x`],
    ["whitespace lines", `hi\n${" \n".repeat(50_000)}x`],
    ["trailing tildes", `${"~".repeat(200_000)}x`],
  ])("reply stripping: %s", (_name, text) => {
    expect(elapsedMs(() => stripReply(text))).toBeLessThan(1000);
  });

  test.each([
    ["url( run", `<style>${"url(".repeat(50_000)}</style>`],
    ["url( then spaces", `<p style="background:url(${" ".repeat(200_000)}">x</p>`],
    ["@import run", `<style>${"@import ".repeat(50_000)}</style>`],
  ])("CSS rewriting: %s", (_name, html) => {
    expect(elapsedMs(() => sanitizeHtml(html, options))).toBeLessThan(1000);
  });
});

describe("HTML limits", () => {
  // jsdom and html-to-text recursed per nesting level and overflowed the stack at about
  // 5,000 levels; parse5's work grows with depth, so 100,000 levels took seconds to parse.
  test("hostile nesting is refused quickly, and nothing throws", () => {
    const html = `${"<div>".repeat(100_000)}deep`;
    const ms = elapsedMs(() => {
      expect(sanitizeHtml(html, options)).toEqual({
        html: "",
        remoteImageCount: 0,
        linkMismatches: [],
        limit: "too-deep",
      });
      expect(isLongForm({ cleanText: "", html })).toBe(true);
      cleanMessage({ text: null, html, subject: "" });
    });
    expect(ms).toBeLessThan(2000);
  });

  test("nesting under the refusal limit renders, with the deepest content kept as text", () => {
    const html = `${"<div>".repeat(1_500)}<b>deep</b>${"</div>".repeat(1_500)}`;
    const { html: clean, limit } = sanitizeHtml(html, options);
    expect(limit).toBeNull();
    expect(clean).toContain("deep");
    expect(clean).not.toContain("<b>");
    expect(stripQuotedHtml(html)).toContain("deep");
    expect(htmlToPlainText(html)).toContain("...");
  });

  test("HTML past the size limit is clipped and says so", () => {
    const html = `<p>${"word ".repeat(MAX_HTML_LENGTH / 4)}</p>`;
    const result = sanitizeHtml(html, options);
    expect(result.limit).toBe("clipped");
    expect(result.html.length).toBeLessThan(MAX_HTML_LENGTH + 100);
  });
});

describe("parse robustness", () => {
  const header =
    "From: Ana <ana@example.com>\r\nTo: sam@example.com\r\nMessage-ID: <m1@example.com>\r\n";

  test("NUL bytes never reach the message, which Postgres text cannot store", async () => {
    const raw =
      `${header}Subject: a\0b\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n` +
      `--b\r\nContent-Type: text/html\r\n\r\n<p>hi\0there</p>\r\n` +
      `--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="f\0.txt"\r\n\r\nzz\r\n--b--\r\n`;
    const { message } = await parseMessage(raw);
    expect(JSON.stringify(message)).not.toContain("\\u0000");
    expect(message.subject).toBe("ab");
    expect(message.attachments[0]?.filename).toBe("f.txt");
  });

  // mailparser refuses over 1 MB of headers or 1,000 MIME parts by throwing, which would
  // fail the message on every sync.
  test("a header bomb keeps the message listable from its main headers", async () => {
    const references = Array.from({ length: 60_000 }, (_, i) => `<r${i}@example.com>`).join(" ");
    const raw = `${header}Subject: Still here\r\nReferences: ${references}\r\nX-Junk: ${"a".repeat(1_100_000)}\r\n\r\nbody`;
    const { message } = await parseMessage(raw);
    expect(message.bodySkipped).toBe(true);
    expect(message.subject).toBe("Still here");
    expect(message.from).toEqual({ name: "Ana", address: "ana@example.com" });
    expect(message.text).toBeNull();
    expect(message.references.length).toBeLessThanOrEqual(100);
    expect(message.references[0]).toBe("<r0@example.com>");
  });

  test("a MIME-part bomb keeps the message listable from its main headers", async () => {
    const parts = Array.from(
      { length: 1_200 },
      () => "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n",
    );
    const raw = `${header}Subject: Parts\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${parts.join("")}--b--\r\n`;
    const { message } = await parseMessage(raw);
    expect(message.bodySkipped).toBe(true);
    expect(message.subject).toBe("Parts");
  });

  test("References are cut to the first and the most recent ids", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `<r${i}@example.com>`);
    const { message } = await parseMessage(`${header}References: ${ids.join(" ")}\r\n\r\nx`);
    expect(message.references).toEqual([ids[0], ...ids.slice(-99)]);
  });

  test("malformed MIME still yields the text", async () => {
    const raw =
      `${header}Subject: =?x-bogus?Q?caf=E9?=\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n` +
      `--b\r\nContent-Type: text/plain; charset=x-bogus\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello there=\r\n` +
      `--b\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n!!not base64!!\r\n`;
    const { message } = await parseMessage(raw);
    expect(message.text).toContain("Hello there");
    expect(message.attachments).toHaveLength(1);
  });
});

describe("display-name spoofing hints", () => {
  test.each([
    [
      '"support@paypal.com" <evil@attacker.example>',
      { kind: "address", claimed: "support@paypal.com" },
    ],
    ['"PayPal.com Security" <alerts@attacker.example>', { kind: "domain", claimed: "paypal.com" }],
    ['"Pay​pal" <alerts@attacker.example>', { kind: "invisible", claimed: "U+200B" }],
    ['"Ana ‮moc.lapyap" <ana@attacker.example>', { kind: "invisible", claimed: "U+202E" }],
    ['"ana@example.com" <ana@example.com>', null],
    ['"Booking.com" <noreply@mail.booking.com>', null],
    ['"Ana Pérez" <ana@example.com>', null],
  ])("%s", async (from, expected) => {
    const { message } = await parseMessage(`From: ${from}\r\nSubject: s\r\n\r\nx`);
    expect(message.signals.displayNameSpoof).toEqual(expected);
    expect(displayNameSpoof(message.from)).toEqual(expected);
  });
});
