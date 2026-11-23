import { Buffer } from "node:buffer";
import type { HeaderLines } from "mailparser";
import { header } from "./headers.ts";

const MESSAGE_ID = /<[^<>\s]+>/g;

export const messageIds: (value: string | string[] | undefined) => string[] = (value) => {
  const joined = Array.isArray(value) ? value.join(" ") : (value ?? "");
  const bracketed = joined.match(MESSAGE_ID);
  if (bracketed) return [...new Set(bracketed)];
  return [...new Set(joined.split(/\s+/).filter((id) => id.includes("@")))].map((id) => `<${id}>`);
};

export function firstMessageId(value: string | undefined) {
  return messageIds(value)[0] ?? null;
}

const MAX_REFERENCES = 100;

export const capReferences: (ids: string[]) => string[] = (ids) => {
  if (ids.length <= MAX_REFERENCES) return ids;
  return [...ids.slice(0, 1), ...ids.slice(-(MAX_REFERENCES - 1))];
};

export async function synthesizeMessageId(
  lines: HeaderLines,
  text: string | undefined,
  html: string | false | undefined,
) {
  const keyHeaders = ["from", "to", "cc", "date", "subject"]
    .map((key) => `${key}:${header(lines, key) ?? ""}`)
    .join("\n");
  return hashedMessageId(`${keyHeaders}\n\n${text ?? ""}\n\n${html || ""}`);
}

async function hashedMessageId(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `<${hex.slice(0, 40)}@omni.invalid>`;
}

const INDEXABLE_ID_BYTES = 2600;

export async function boundedId(id: string) {
  if (Buffer.byteLength(id) <= INDEXABLE_ID_BYTES) return id;
  return hashedMessageId(id);
}

const HASHED_BEFORE_BYTES = 998;

export async function idAliases(id: string) {
  const bytes = Buffer.byteLength(id);
  if (bytes <= HASHED_BEFORE_BYTES) return [];
  return bytes <= INDEXABLE_ID_BYTES ? [await hashedMessageId(id)] : [id];
}

export async function boundedIds(ids: string[]) {
  return [...new Set(await Promise.all(ids.map(boundedId)))];
}
