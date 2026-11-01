// `pnpm --filter @omni/mail-core bench`: parse → strip → sanitize on large realistic mail.
// Not part of `pnpm test`. Numbers for the record live in the PR that changed them.
import { bench, describe } from "vitest";
import { cleanMessage, isLongForm, sanitizeHtml } from "../src/html.ts";
import { parseMessage } from "../src/parse.ts";
import { gmailChain, manyAttachments, newsletter, outlookChain } from "./corpus.ts";

const MB = 1024 * 1024;
const options = {
  proxyUrl: (src: string) => `https://img.omni.test/p?u=${encodeURIComponent(src)}`,
  cidUrl: (id: string) => `https://omni.test/attachments/${encodeURIComponent(id)}`,
};
// Heavy cases: a few runs each is enough to see the shape.
const runs = { iterations: 3, warmupIterations: 1, time: 0, warmupTime: 0 };

const CORPUS = {
  // Under MAX_HTML_LENGTH, so before and after do the same work.
  "newsletter 900 KB": newsletter(900 * 1024),
  // Over it: sanitizing and text extraction read the first MAX_HTML_LENGTH characters.
  "newsletter 2 MB": newsletter(2 * MB),
  "newsletter 10 MB": newsletter(10 * MB),
  "outlook chain 500 deep": outlookChain(500),
  "gmail chain 500 deep": gmailChain(500),
  "100 attachments × 100 KB": manyAttachments(100, 100 * 1024),
};

for (const [name, raw] of Object.entries(CORPUS)) {
  const { message } = await parseMessage(raw);
  const cleanText = cleanMessage(message).cleanText;

  describe(`${name}`, () => {
    bench("parseMessage", async () => void (await parseMessage(raw)), runs);
    bench("cleanMessage", () => void cleanMessage(message), runs);
    bench("cleanMessage (HTML only)", () => void cleanMessage({ ...message, text: null }), runs);
    if (message.html !== null) {
      const html = message.html;
      bench("sanitizeHtml", () => void sanitizeHtml(html, options), runs);
      bench("isLongForm", () => void isLongForm({ cleanText, html }), runs);
    }
  });
}
