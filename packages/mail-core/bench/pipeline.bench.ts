import { test } from "vitest";
import { cleanMessage, isLongForm, sanitizeHtml } from "../src/html.ts";
import { parseMessage } from "../src/parse.ts";
import { gmailChain, manyAttachments, newsletter, outlookChain } from "./corpus.ts";

const MB = 1024 * 1024;
const options = {
  proxyUrl: (src: string) => `https://img.omni.test/p?u=${encodeURIComponent(src)}`,
  cidUrl: (id: string) => `https://omni.test/attachments/${encodeURIComponent(id)}`,
};
const runs = { iterations: 3, warmupIterations: 1, time: 0, warmupTime: 0 };

const CORPUS = {
  "newsletter 900 KB": newsletter(900 * 1024),
  "newsletter 2 MB": newsletter(2 * MB),
  "newsletter 10 MB": newsletter(10 * MB),
  "outlook chain 500 deep": outlookChain(500),
  "gmail chain 500 deep": gmailChain(500),
  "100 attachments × 100 KB": manyAttachments(100, 100 * 1024),
};

for (const [name, raw] of Object.entries(CORPUS)) {
  const { message } = await parseMessage(raw);
  const cleanText = cleanMessage(message).cleanText;

  // oxlint-disable-next-line vitest/expect-expect
  test(`${name}`, async ({ bench }) => {
    const { html } = message;
    const cases = [
      bench("parseMessage", async () => void (await parseMessage(raw))),
      bench("cleanMessage", () => void cleanMessage(message)),
      bench("cleanMessage (HTML only)", () => void cleanMessage({ ...message, text: null })),
      ...(html === null
        ? []
        : [
            bench("sanitizeHtml", () => void sanitizeHtml(html, options)),
            bench("isLongForm", () => void isLongForm({ cleanText, html })),
          ]),
    ];
    await bench.compare(...cases, runs);
  });
}
