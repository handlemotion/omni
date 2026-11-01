// Large, realistic mail built in memory for the benchmark. Shapes follow what real senders
// emit: ESP newsletters (tables, inline styles, tracking pixels, base64 HTML), Outlook reply
// chains (a header block per reply, no ">" quoting), Gmail chains (nested blockquotes), and
// messages carrying many attachments.
import { Buffer } from "node:buffer";

const CRLF = "\r\n";

function base64Lines(content: string | Buffer): string {
  const encoded = Buffer.from(content).toString("base64");
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? "";
}

function headers(subject: string, extra: string[] = []): string {
  return [
    "From: Pixel Weekly <news@pixelweekly.example.com>",
    "To: sam@example.com",
    `Subject: ${subject}`,
    "Date: Fri, 31 Oct 2026 06:00:00 +0000",
    `Message-ID: <${subject.replace(/\W+/g, "-")}@bench.example.com>`,
    "MIME-Version: 1.0",
    ...extra,
  ].join(CRLF);
}

function alternative(subject: string, text: string, html: string, extra: string[] = []): string {
  const boundary = "=_alt_boundary";
  return [
    headers(subject, extra),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

const STYLE = Array.from(
  { length: 200 },
  (_, i) =>
    `.c${i} { font-family: Helvetica, Arial, sans-serif; color: #33${i % 10}; padding: ${i % 24}px; background: url("https://cdn.pixelweekly.example.com/bg/${i}.png") no-repeat; }`,
).join("\n");

function article(i: number): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="c${i % 200}">
<tr><td style="padding:24px;background-image:url('https://cdn.pixelweekly.example.com/a/${i}.jpg')">
<img src="https://cdn.pixelweekly.example.com/img/${i}.png" width="600" height="300" alt="Story ${i}" style="display:block;border:0">
<h2 style="font-size:22px;margin:16px 0 8px">Story ${i}: shipping variable fonts without hurting load times</h2>
<p style="font-size:16px;line-height:24px;color:#333">Subsetting, preloading the right axis ranges and picking sensible fallbacks matter more than the format itself. We measured ${i} sites and found the same three mistakes again and again.</p>
<table><tr><th>Font</th><th>Size</th></tr><tr><td>Inter Var</td><td>${300 + i} KB</td></tr></table>
<p><a href="https://click.pixelweekly.example.com/r/${i}?u=7731&amp;t=a9f2" style="color:#06c">Read the full story</a> &middot; <a href="https://pixelweekly.example.com/share/${i}">pixelweekly.example.com/share/${i}</a></p>
<img src="https://t.pixelweekly.example.com/open.gif?id=7731&amp;s=${i}" width="1" height="1" alt="">
</td></tr></table>
`;
}

/** An ESP newsletter of about `bytes` of HTML, with a matching text part. */
export function newsletter(bytes: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const block = article(i);
    parts.push(block);
    size += block.length;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${parts.join("")}</body></html>`;
  const text = parts
    .map(
      (_, i) => `Story ${i}: shipping variable fonts\n\nRead: https://click.example.com/r/${i}\n`,
    )
    .join("\n");
  return alternative(`Newsletter ${bytes}`, text, html, [
    "List-Id: Pixel Weekly <weekly.pixelweekly.example.com>",
    "List-Unsubscribe: <https://pixelweekly.example.com/u/7731>",
  ]);
}

/** An Outlook desktop reply chain: each reply quotes the whole history under a header block. */
export function outlookChain(depth: number): string {
  const text: string[] = [];
  const html: string[] = [];
  for (let i = depth; i > 0; i--) {
    const body = `Reply ${i}: the revised contract is attached; clause ${i} is fine as written.\n\nThanks,\nLuis`;
    if (i < depth) {
      text.push(
        "________________________________",
        `From: Person ${i} <person${i}@acmelegal.example.net>`,
        `Sent: Tuesday, October 28, 2026 10:${String(i % 60).padStart(2, "0")} AM`,
        "To: Sam Ortiz <sam@example.com>",
        "Subject: RE: Contract review",
        "",
      );
      html.push(
        `<hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Person ${i} &lt;person${i}@acmelegal.example.net&gt;<br><b>Sent:</b> Tuesday, October 28, 2026 10:00 AM<br><b>To:</b> Sam Ortiz<br><b>Subject:</b> RE: Contract review</font><div>&nbsp;</div></div>`,
      );
    }
    text.push(body, "");
    html.push(
      `<div class="WordSection1"><p class="MsoNormal">${body.replace(/\n/g, "<br>")}</p></div>`,
    );
  }
  return alternative(
    `Outlook chain ${depth}`,
    text.join("\n"),
    `<html><body>${html.join("")}</body></html>`,
  );
}

/** A Gmail chain: every reply nests the previous one in a blockquote and quotes it with ">". */
export function gmailChain(depth: number): string {
  let html = "<div>First message in the thread.</div>";
  let text = "First message in the thread.";
  for (let i = 1; i < depth; i++) {
    html = `<div dir="ltr">Reply ${i}, agreed.</div><div class="gmail_quote"><div class="gmail_attr">On Thu, Oct 30, 2026 at 10:00 AM Person ${i} &lt;p${i}@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${html}</blockquote></div>`;
    const quoted = text
      .split("\n")
      .map((line) => `>${line.startsWith(">") ? "" : " "}${line}`)
      .join("\n");
    text = `Reply ${i}, agreed.\n\nOn Thu, Oct 30, 2026 at 10:00 AM Person ${i} <p${i}@example.com> wrote:\n\n${quoted}`;
  }
  return alternative(`Gmail chain ${depth}`, text, `<html><body>${html}</body></html>`);
}

/** A short note with `count` attachments of `size` bytes each. */
export function manyAttachments(count: number, size: number): string {
  const boundary = "=_mixed_boundary";
  const blob = Buffer.alloc(size, 0x5a);
  const parts = [
    headers(`Attachments ${count}`),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Scans from the site visit attached.",
  ];
  for (let i = 0; i < count; i++) {
    parts.push(
      `--${boundary}`,
      `Content-Type: image/jpeg; name="scan-${i}.jpg"`,
      `Content-Disposition: attachment; filename="scan-${i}.jpg"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(blob),
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join(CRLF);
}
