// The streaming parser is a second reader of the same mail. If it drifts from `parseMessage`,
// a large message would be indexed differently from a small one (wrong thread, lost attachment,
// missed bounce) and only in production, where large mail takes that path.
import { readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseMessage, parseMessageStream } from "./parse.ts";

const dir = new URL("../../../fixtures/eml/", import.meta.url);
const fixtures = readdirSync(dir).filter((name) => name.endsWith(".eml"));

async function streamed(raw: Buffer) {
  const contents: Buffer[] = [];
  const { message } = await parseMessageStream(
    // Small chunks, so parts and headers straddle chunk boundaries as they do off the network.
    () =>
      Readable.from(
        Array.from({ length: Math.ceil(raw.length / 97) }, (_, i) =>
          raw.subarray(i * 97, (i + 1) * 97),
        ),
      ),
    async (index, content) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(chunk as Buffer);
      contents[index] = Buffer.concat(chunks);
    },
  );
  return { message, contents };
}

describe("parseMessageStream", () => {
  test.each(fixtures)("reads %s exactly as parseMessage does", async (name) => {
    const raw = readFileSync(new URL(name, dir));
    const whole = await parseMessage(raw);
    const { message, contents } = await streamed(raw);

    expect(message).toEqual(whole.message);
    expect(contents.map((c) => new Uint8Array(c))).toEqual(whole.attachmentContents);
  });

  test("a MIME tree past the parser's limits falls back to the top headers", async () => {
    const parts = Array.from(
      { length: 1100 },
      (_, i) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`,
    );
    const raw = Buffer.from(
      `From: a@x.test\r\nSubject: bomb\r\nMessage-ID: <bomb@x.test>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${parts.join("")}--b--\r\n`,
    );
    const whole = await parseMessage(raw);
    const { message } = await streamed(raw);

    expect(whole.message.bodySkipped).toBe(true);
    expect(message).toEqual(whole.message);
  });
});
