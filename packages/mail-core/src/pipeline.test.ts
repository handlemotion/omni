// Every fixture through parse → strip → sanitize, asserting the outputs the product shows.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BLOCKED_SRC_ATTR, cleanMessage, isLongForm, sanitizeHtml } from "./html";
import { parseMessage } from "./parse";

const read = (name: string) =>
  readFileSync(new URL(`../../../fixtures/eml/${name}`, import.meta.url));
const parse = async (name: string) => (await parseMessage(read(name))).message;

const words = (s: string) => s.split(/\s+/).join(" ");

const PROXY = "https://img.omni.test/p?u=";
const sanitizeOptions = {
  proxyUrl: (src: string) => PROXY + encodeURIComponent(src),
  cidUrl: (contentId: string) => `https://omni.test/attachments/${encodeURIComponent(contentId)}`,
};

const FIXTURES = [
  "apple-mail-reply.eml",
  "cc-added-mid-thread.eml",
  "gmail-forward.eml",
  "gmail-reply.eml",
  "multipart-attachments.eml",
  "newsletter-html-only.eml",
  "no-message-id.eml",
  "non-utf8-windows-1252.eml",
  "outlook-desktop-reply.eml",
  "outlook-forward.eml",
  "outlook-web-reply-html-only.eml",
];

describe("clean_text", () => {
  test.each([
    [
      "gmail-reply.eml",
      "Hi Sam,\n\nThursday at 11 works for us. I'll bring the updated logo files and the\ntype specimen.",
    ],
    [
      "outlook-desktop-reply.eml",
      "Hi Sam,\n\nClause 7 is fine as written. Please send the signed copy by Friday.\n\nThanks,\nLuis",
    ],
    [
      "outlook-web-reply-html-only.eml",
      "The 14th works. We'll have 20 people, so the bigger room is better.\n\nMarta",
    ],
    ["apple-mail-reply.eml", "Perfect, see you there."],
    ["cc-added-mid-thread.eml", "Adding Bea, who will run the type review on Thursday."],
    [
      "non-utf8-windows-1252.eml",
      "Hola Sam,\n\nConfirmo la reunión de mañana a las 10:00. El presupuesto es de 1.200 € más IVA.\n\nUn saludo,\nIñigo",
    ],
    ["no-message-id.eml", "The window moves to Saturday 06:00 UTC. Nothing else changes."],
  ])("%s keeps only the new content", async (name, expected) => {
    const result = cleanMessage(await parse(name));
    expect(result).toEqual({ cleanText: expected, forwarded: null });
  });

  // The text part is what we normally strip; these prove the HTML-only path cuts the same
  // quoted history when a client sends no text part.
  test.each(["gmail-reply.eml", "outlook-desktop-reply.eml", "apple-mail-reply.eml"])(
    "%s: HTML-only stripping agrees with the text part",
    async (name) => {
      const message = await parse(name);
      const fromHtml = cleanMessage({ ...message, text: null }).cleanText;
      expect(words(fromHtml)).toBe(words(cleanMessage(message).cleanText));
    },
  );

  test("a Gmail forward keeps the note and returns the forwarded message as a card", async () => {
    const message = await parse("gmail-forward.eml");
    const expected = {
      cleanText: "Can you pay this one before Monday?",
      forwarded: {
        from: "Northwind Hosting <billing@northwind.example.net>",
        date: "Thu, Oct 30, 2026 at 4:02 PM",
        subject: "Invoice INV-2026-0412 from Northwind Hosting",
        to: "<sam@example.com>",
        text: "Hello,\n\nYour invoice INV-2026-0412 for 49.00 EUR is due on November 3, 2026.\n\nNorthwind Hosting",
      },
    };
    expect(cleanMessage(message)).toEqual(expected);
    // Gmail puts the forward inside .gmail_quote; HTML-only stripping must not delete it.
    const fromHtml = cleanMessage({ ...message, text: null });
    expect(fromHtml.cleanText).toBe(expected.cleanText);
    expect(fromHtml.forwarded?.from).toBe(expected.forwarded.from);
    expect(fromHtml.forwarded?.text).toContain("Your invoice INV-2026-0412 for 49.00 EUR");
  });

  test("an Outlook forward is told apart from a reply by its FW: subject", async () => {
    expect(cleanMessage(await parse("outlook-forward.eml"))).toEqual({
      cleanText: "For your records.\n\nLuis",
      forwarded: {
        from: "Registry Office <noreply@registry.example.org>",
        date: "Friday, October 31, 2026 11:12 AM",
        subject: "Filing confirmation",
        to: "Luis Romero <luis.romero@acmelegal.example.net>",
        text: "Filing 2026/88412 was received and is under review.",
      },
    });
  });
});

describe("parseMessage", () => {
  test("decodes windows-1252 bodies and ISO-8859-1 encoded-word headers", async () => {
    const message = await parse("non-utf8-windows-1252.eml");
    expect(message.subject).toBe("Reunión de mañana");
    expect(message.from).toEqual({
      name: "Iñigo Ibáñez",
      address: "inigo@talleresbilbao.example.net",
    });
  });

  test("reads reply headers in order", async () => {
    const message = await parse("apple-mail-reply.eml");
    expect(message.inReplyTo).toBe("<CAF3kq1y2Zx9Pk@mail.example.com>");
    expect(message.references).toEqual([
      "<CAF3kq1x8Yd0Zr2@mail.example.com>",
      "<CAGm7xR2pQw9LkV4n+YtE5uB1aD@mail.gmail.example.com>",
      "<CAF3kq1y2Zx9Pk@mail.example.com>",
    ]);
  });

  test("a missing Message-ID becomes a hash that is stable across re-syncs", async () => {
    const raw = read("no-message-id.eml");
    const first = (await parseMessage(raw)).message;
    const again = (await parseMessage(raw)).message;
    expect(first.messageIdSynthesized).toBe(true);
    expect(first.messageId).toMatch(/^<[0-9a-f]{40}@omni\.invalid>$/);
    expect(again.messageId).toBe(first.messageId);
    // Same headers, different body: two automated messages must not collapse into one row.
    const other = new TextDecoder().decode(raw).replace("Saturday", "Sunday");
    expect((await parseMessage(other)).message.messageId).not.toBe(first.messageId);
  });

  test("returns attachment metadata with contents, and maps cid images to attachments", async () => {
    const { message, attachmentContents } = await parseMessage(read("multipart-attachments.eml"));
    expect(message.attachments).toEqual([
      {
        filename: "logo-mark.png",
        mimeType: "image/png",
        size: 70,
        contentId: "logo-mark@studionorte.example.org",
        inline: true,
      },
      {
        filename: "brand-guidelines.pdf",
        mimeType: "application/pdf",
        size: 125,
        contentId: null,
        inline: false,
      },
    ]);
    expect(attachmentContents.map((c) => c.byteLength)).toEqual([70, 125]);
    expect(new TextDecoder().decode(attachmentContents[1]?.subarray(0, 8))).toBe("%PDF-1.4");

    // keepCidLinks: mailparser would otherwise inline the image as a data: URI.
    const { html } = sanitizeHtml(message.html ?? "", sanitizeOptions);
    expect(html).toContain(
      'src="https://omni.test/attachments/logo-mark%40studionorte.example.org"',
    );
  });

  test("exposes list headers as triage signals", async () => {
    expect((await parse("newsletter-html-only.eml")).signals).toEqual({
      listId: "Pixel Weekly <weekly.pixelweekly.example.com>",
      listUnsubscribe: [
        "https://pixelweekly.example.com/u/7731?t=a9f2",
        "mailto:unsubscribe-7731@pixelweekly.example.com",
      ],
      listUnsubscribeOneClick: true,
      precedence: "bulk",
      autoSubmitted: null,
    });
  });
});

describe("sanitizeHtml", () => {
  test.each(FIXTURES)("%s: nothing executes and nothing loads from the sender", async (name) => {
    const message = await parse(name);
    if (message.html === null) return;
    const { html } = sanitizeHtml(message.html, sanitizeOptions);
    expect(html).not.toMatch(/<script|<iframe|<form|<svg|<link|<meta|<base/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/@import/i);
    // Any remaining URL that loads by itself points at our proxy or our attachments.
    for (const [, url] of html.matchAll(/(?:\ssrc=|url\()\s*["']?([^"')\s>]+)/gi)) {
      expect(url).toMatch(/^https:\/\/(?:img\.)?omni\.test\//);
    }
  });

  test("blocks remote images by default, including tracking pixels", async () => {
    const message = await parse("newsletter-html-only.eml");
    const { html, remoteImageCount } = sanitizeHtml(message.html ?? "", sanitizeOptions);
    expect(remoteImageCount).toBe(3);
    expect(html).not.toMatch(/<img[^>]*\ssrc=/);
    expect(html).toContain(
      `${BLOCKED_SRC_ATTR}="${PROXY}${encodeURIComponent("https://t.pixelweekly.example.com/open.gif?id=7731")}"`,
    );
    // Protocol-relative URLs are remote too.
    expect(html).toContain(encodeURIComponent("https://t.pixelweekly.example.com/open2.gif"));
    // A sender cannot pre-fill the attribute the client swaps into src.
    expect(html).not.toContain("sneaky.gif");
    // CSS backgrounds cannot be swapped in later, so blocked means removed.
    expect(html).not.toContain("hero.jpg");
    expect(html).not.toContain("bg-track.gif");
    expect(html).not.toContain("bg.jpg");
  });

  test("loads remote images through the proxy when the reader allows it", async () => {
    const message = await parse("newsletter-html-only.eml");
    const { html } = sanitizeHtml(message.html ?? "", {
      ...sanitizeOptions,
      remoteImages: "proxy",
    });
    expect(html).toContain(
      `src="${PROXY}${encodeURIComponent("https://cdn.pixelweekly.example.com/banner.png")}"`,
    );
    expect(html).toContain(
      `url("${PROXY}${encodeURIComponent("https://cdn.pixelweekly.example.com/hero.jpg")}")`,
    );
  });

  test("CSS tricks cannot smuggle in a remote load", () => {
    const html = [
      `<p style="background:url('data:image/png,x\\'); background:url(https://t.example.com/a.gif)')">a</p>`,
      `<p style="background:\\75 rl(https://t.example.com/b.gif)">b</p>`,
      `<p style="background-image:image-set('https://t.example.com/c.gif' 1x)">c</p>`,
      `<p style="background:url('data:image/png,&quot;);background:url(https://t.example.com/d.gif')">d</p>`,
    ].join("");
    expect(sanitizeHtml(html, sanitizeOptions).html).not.toContain("t.example.com");
  });

  test("keeps newsletter styles and links, opening links outside the frame", async () => {
    const { html } = sanitizeHtml(
      (await parse("newsletter-html-only.eml")).html ?? "",
      sanitizeOptions,
    );
    expect(html).toContain("font-family: Georgia, serif;");
    expect(html).toContain(
      '<a href="https://pixelweekly.example.com/r/7731/variable-fonts" target="_blank" rel="noopener noreferrer nofollow">',
    );
  });
});

describe("isLongForm", () => {
  test("data tables and long text render as cards; replies and layout tables as bubbles", async () => {
    const newsletter = await parse("newsletter-html-only.eml");
    expect(
      isLongForm({ cleanText: cleanMessage(newsletter).cleanText, html: newsletter.html }),
    ).toBe(true);

    // Gmail and Outlook replies carry tables only in quoted history, if at all.
    for (const name of ["gmail-reply.eml", "outlook-desktop-reply.eml"]) {
      const message = await parse(name);
      expect(isLongForm({ cleanText: cleanMessage(message).cleanText, html: message.html })).toBe(
        false,
      );
    }

    const signature =
      "<p>Sounds good.</p><table><tr><td><img src='cid:x'></td><td>Ana Pérez<br>Studio Norte</td></tr></table>";
    expect(isLongForm({ cleanText: "Sounds good.", html: signature })).toBe(false);
    const quotedTable = `<p>See below.</p><blockquote type="cite"><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table></blockquote>`;
    expect(isLongForm({ cleanText: "See below.", html: quotedTable })).toBe(false);

    expect(isLongForm({ cleanText: "word ".repeat(120), html: null })).toBe(false);
    expect(isLongForm({ cleanText: "word ".repeat(121), html: null })).toBe(true);
  });
});
