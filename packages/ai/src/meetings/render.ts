import type { Turn } from "./transcript.ts";

/** `mm:ss`, or `h:mm:ss` from an hour on. */
export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

/** `mm:ss` or `h:mm:ss` back to ms; null for anything else. */
export function parseClock(clock: string) {
  const match = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(clock);
  if (!match) return null;
  const [, h = "0", m = "0", s = "0"] = match;
  if (Number(s) > 59 || (match[1] !== undefined && Number(m) > 59)) return null;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

/** The transcript as the model reads it: one turn a line, `[mm:ss] Name: text`. */
export function renderTranscript(turns: Turn[], titles: Map<string, string>) {
  return turns
    .map(
      (t) => `[${formatClock(t.startMs)}] ${titles.get(t.speaker ?? "") ?? "Unknown"}: ${t.text}`,
    )
    .join("\n");
}

/** Rendered lines in parts of at most `maxChars`, never splitting a line. */
export function splitLines(text: string, maxChars: number) {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > maxChars) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}
