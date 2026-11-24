/**
 * A meeting another notetaker recorded (Circleback's webhook and API shape), turned into what
 * Meetings saves: transcript turns, speakers, notes and actions. No audio: the meeting is its
 * transcript and its notes (`docs/spec/meetings.md`, "Importing").
 */
export interface ForeignMeeting {
  id: string;
  name?: string | null;
  createdAt: string;
  /** Seconds. */
  duration?: number | null;
  attendees: Array<{ name?: string | null; email?: string | null }>;
  notes?: string | null;
  actionItems: Array<{
    title: string;
    description?: string | null;
    assignee?: { name?: string | null; email?: string | null } | null;
    status?: string | null;
  }>;
  transcript: Array<{ speaker?: string | null; text: string; timestamp: number }>;
}

export interface ImportedMeeting {
  title: string | null;
  startedAt: Date;
  durationMs: number;
  attendees: Array<{ address: string; name: string | null }>;
  turns: Array<{ speaker: string | null; startMs: number; endMs: number; text: string }>;
  speakers: Array<{ label: string; name: string | null; address: string | null }>;
  notes: {
    summary: string;
    topics: string[];
    chapters: Array<{ title: string; startMs: number; points: string[] }>;
  } | null;
  actions: Array<{
    payload: { title: string; description: string | null; owner: string | null };
    done: boolean;
  }>;
}

const UNNAMED_VOICE = /^(participant|speaker|unknown|guest)\b[\s#]*\d*$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function importForeignMeeting(input: ForeignMeeting) {
  const attendees = attendeesOf(input.attendees);
  const turns = turnsOf(input.transcript, input.duration);
  const durationMs = Math.max(Math.round((input.duration ?? 0) * 1000), turns.at(-1)?.endMs ?? 0);
  const imported: ImportedMeeting = {
    title: input.name?.trim() || null,
    startedAt: new Date(input.createdAt),
    durationMs,
    attendees,
    turns,
    speakers: speakersOf(turns, input.attendees),
    notes: notesOf(input.notes ?? "", turns),
    actions: input.actionItems
      .filter((a) => a.title.trim())
      .map((a) => ({
        payload: {
          title: a.title.replace(/\s+/g, " ").trim(),
          description: a.description?.trim() || null,
          owner: a.assignee?.name?.trim() || a.assignee?.email?.trim() || null,
        },
        done: a.status?.toUpperCase() === "DONE",
      })),
  };
  return imported;
}

function attendeesOf(people: ForeignMeeting["attendees"]) {
  const byAddress = new Map<string, string | null>();
  for (const p of people) {
    const address = p.email?.trim().toLowerCase();
    if (address && EMAIL.test(address) && !byAddress.has(address)) {
      byAddress.set(address, p.name?.trim() || null);
    }
  }
  return [...byAddress].map(([address, name]) => ({ address, name }));
}

function turnsOf(lines: ForeignMeeting["transcript"], duration: number | null | undefined) {
  const kept = lines
    .map((l) => ({
      speaker: l.speaker?.trim() || null,
      startMs: Math.round(l.timestamp * 1000),
      text: l.text.trim(),
    }))
    .filter((l) => l.text)
    .toSorted((a, b) => a.startMs - b.startMs);
  const endOfMeeting = Math.round((duration ?? 0) * 1000);
  return kept.map((l, i) => {
    const next = kept[i + 1]?.startMs ?? Math.max(endOfMeeting, l.startMs);
    return { ...l, endMs: Math.max(l.startMs, next) };
  });
}

function speakersOf(turns: ImportedMeeting["turns"], people: ForeignMeeting["attendees"]) {
  const addressOf = new Map<string, string>();
  for (const p of people) {
    const name = p.name?.trim().toLowerCase();
    const email = p.email?.trim().toLowerCase();
    if (name && email && EMAIL.test(email)) addressOf.set(name, email);
  }
  const labels = [...new Set(turns.map((t) => t.speaker).filter((s): s is string => !!s))];
  return labels.map((label) => {
    const named = !UNNAMED_VOICE.test(label);
    return {
      label,
      name: named ? label : null,
      address: named ? (addressOf.get(label.toLowerCase()) ?? null) : null,
    };
  });
}

interface Section {
  title: string;
  points: string[];
}

/** `#` headings over bullets. Text before the first heading is a section with no title. */
export function sectionsOf(markdown: string) {
  const sections: Section[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      sections.push({ title: plain(heading[1] ?? ""), points: [] });
      continue;
    }
    const text = plain(line.replace(/^([*+-]|\d+[.)])\s+/, ""));
    if (!text) continue;
    if (!sections.length) sections.push({ title: "", points: [] });
    sections.at(-1)?.points.push(text);
  }
  return sections.filter((s) => s.title || s.points.length);
}

const plain = (text: string) =>
  text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();

const sentence = (text: string) => (/[.!?…:]$/.test(text) ? text : `${text}.`);

function notesOf(markdown: string, turns: ImportedMeeting["turns"]) {
  const sections = sectionsOf(markdown);
  const [first, ...rest] = sections;
  if (!first) return null;
  const chapters = rest
    .filter((s) => s.title)
    .map((s) => ({
      title: s.title,
      startMs: anchor([s.title, ...s.points].join(" "), turns),
      points: s.points,
    }));
  return {
    summary: first.points.map(sentence).join(" "),
    topics: chapters.map((c) => c.title),
    chapters,
  };
}

const words = (text: string) =>
  new Set(
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 5 || /^\d+$/.test(w)),
  );

/**
 * The turn that starts saying the section: of the turns that say one of its words, the one that,
 * with the turn after it, says the most of them. The start when none does.
 */
export function anchor(text: string, turns: Array<{ startMs: number; text: string }>) {
  const wanted = words(text);
  const hits = turns.map((t) => [...words(t.text)].filter((w) => wanted.has(w)).length);
  let best = { score: 0, startMs: 0 };
  for (let i = 0; i < turns.length; i++) {
    const score = (hits[i] ?? 0) + (hits[i + 1] ?? 0);
    if ((hits[i] ?? 0) > 0 && score > best.score) {
      best = { score, startMs: turns[i]?.startMs ?? 0 };
    }
  }
  return best.startMs;
}
