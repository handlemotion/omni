/** One client's entry in an awareness update. */
export interface PresenceEntry {
  clientId: number;
  clock: number;
  /** The client's state, parsed; null when it left. */
  state: Record<string, unknown> | null;
}

/** Who someone is to the others in a doc, as the server says. */
export interface PresenceUser {
  name: string;
  /** 1-6: which of the six collaborator colours is theirs. */
  slot: number;
  kind: "member" | "grantee" | "guest";
}

declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(input: Uint8Array): string };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

const MAX_ENTRIES = 64;
const MAX_STATE = 4096;

class Reader {
  at = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  uint() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.at++];
      if (byte === undefined || shift > 49) throw new RangeError("presence: truncated");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  }
  text(max: number) {
    const length = this.uint();
    if (length > max || this.at + length > this.bytes.length) {
      throw new RangeError("presence: too long");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      this.bytes.subarray(this.at, this.at + length),
    );
    this.at += length;
    return text;
  }
}

/**
 * The entries of a Yjs awareness update, as the realtime object reads a doc's presence
 * (`docs/spec/live-sharing.md`): a count, then per client its id, its clock and its state as JSON
 * (`null` when the client left). Null when it is not one, or is too large to be one.
 */
export function decodePresence(bytes: Uint8Array) {
  try {
    const reader = new Reader(bytes);
    const count = reader.uint();
    if (count > MAX_ENTRIES) return null;
    const entries: PresenceEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = reader.uint();
      const clock = reader.uint();
      const parsed: unknown = JSON.parse(reader.text(MAX_STATE));
      if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return null;
      entries.push({ clientId, clock, state: parsed as Record<string, unknown> | null });
    }
    return reader.at === bytes.length ? entries : null;
  } catch {
    return null;
  }
}

function writeUint(out: number[], value: number) {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

/** The awareness update holding `entries`. */
export function encodePresence(entries: PresenceEntry[]) {
  const out: number[] = [];
  writeUint(out, entries.length);
  for (const entry of entries) {
    writeUint(out, entry.clientId);
    writeUint(out, entry.clock);
    const text = new TextEncoder().encode(JSON.stringify(entry.state));
    writeUint(out, text.length);
    for (const byte of text) out.push(byte);
  }
  return Uint8Array.from(out);
}

const KEPT = ["cursor", "comments"] as const;

/**
 * `state` as others hear it: `user` is who the server says it is, and only the cursor and the
 * comments ping are kept beside it.
 */
export function stampPresence(state: Record<string, unknown> | null, user: PresenceUser) {
  if (state === null) return null;
  const kept: Record<string, unknown> = { user: { ...user } };
  for (const key of KEPT) if (key in state) kept[key] = state[key];
  return kept;
}

const ANIMALS = [
  "Otter",
  "Heron",
  "Lynx",
  "Badger",
  "Falcon",
  "Marten",
  "Ibis",
  "Puffin",
  "Gecko",
  "Bison",
  "Crane",
  "Ferret",
  "Koala",
  "Lemur",
  "Newt",
  "Ocelot",
  "Panda",
  "Quokka",
  "Raven",
  "Stoat",
  "Tapir",
  "Vole",
  "Walrus",
  "Yak",
];

function hash(text: string) {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/** Which of the six collaborator colours belongs to `id`: the same on every screen. */
export const presenceSlot = (id: string) => (hash(id) % 6) + 1;

/** A guest's name on a link, from their guest id: `Guest Otter`. */
export const guestName = (guestId: string) =>
  `Guest ${ANIMALS[hash(`name:${guestId}`) % ANIMALS.length]}`;
