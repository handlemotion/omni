import { ask, type JevClient } from "./jev.ts";
import { truncateToTokens } from "./policy.ts";
import {
  FILE_RELEVANCE_CRITERIA,
  FILE_RELEVANCE_INSTRUCTIONS,
  FILE_SEARCH_NOTE,
  JEV_MODEL,
  RELEVANCE_CRITERIA,
  RELEVANCE_INSTRUCTIONS,
  SEARCH_EXCERPT_TOKENS,
  SEARCH_NOTE,
} from "./questions.ts";

/** A thread full-text search found, as a person would see it in the results. */
export interface SearchCandidate {
  /** Stable key for the candidate, e.g. the thread id. Never sent to the model. */
  id: string;
  subject: string;
  from: { name: string | null; address: string };
  /** When the best-matching message was sent. */
  sentAt: Date;
  /** The mailbox it was found in, e.g. billing@acme.example. */
  mailbox: string;
  messageCount: number;
  /** A passage of the best-matching message around the query's words. */
  excerpt: string;
}

const DAY_MS = 86_400_000;

const longDate = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * "October 12, 2026 (3 weeks ago)": the date and its distance from `now`, both stated so the
 * model never does date arithmetic to read "last month" or "yesterday" in a query.
 */
export function describeDate(date: Date, now: Date) {
  const days = Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) /
      DAY_MS,
  );
  const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const distance =
    days <= 0
      ? "today"
      : days === 1
        ? "yesterday"
        : days < 14
          ? ago(days, "day")
          : days < 60
            ? ago(Math.floor(days / 7), "week")
            : ago(...calendar(date, now));
  return `${shortDate.format(date)} (${distance})`;
}

const calendar: (date: Date, now: Date) => [number, string] = (date, now) => {
  const months =
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    date.getUTCMonth() -
    (now.getUTCDate() < date.getUTCDate() ? 1 : 0);
  return months < 24 ? [months, "month"] : [Math.floor(months / 12), "year"];
};

function questionId(index: number) {
  return `candidate_${index}`;
}

function threadFacts(candidate: SearchCandidate, now: Date) {
  const { name, address } = candidate.from;
  return {
    subject: candidate.subject,
    from: name ? `${name} <${address}>` : address,
    sent: describeDate(candidate.sentAt, now),
    mailbox: candidate.mailbox,
    messages_in_thread: candidate.messageCount,
    excerpt: truncateToTokens(candidate.excerpt, SEARCH_EXCERPT_TOKENS),
  };
}

function relevanceRequest<C>(
  kind: {
    note: string;
    instructions: string;
    criteria: Record<string, string>;
    facts: { name: "thread" | "file"; of: (candidate: C, now: Date) => object };
  },
  query: string,
  candidates: readonly C[],
  options: { now: Date; model?: string },
) {
  return {
    model: options.model ?? JEV_MODEL,
    state: { search_note: kind.note.replace("{today}", longDate.format(options.now)), query },
    questions: Object.fromEntries(
      candidates.map((candidate, i) => [
        questionId(i),
        {
          type: "noul",
          instructions: {
            question: kind.instructions,
            [kind.facts.name]: kind.facts.of(candidate, options.now),
          },
          criteria: kind.criteria,
        },
      ]),
    ),
  };
}

async function judge(
  client: JevClient,
  body: ReturnType<typeof relevanceRequest>,
  candidates: readonly { id: string }[],
  signal: AbortSignal | undefined,
) {
  if (candidates.length === 0) return { relevance: new Map(), model: client.model, tokensIn: 0 };
  const response = await ask(client, body, signal);
  const relevance = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    relevance.set(candidate.id, response.nouls[questionId(i)] ?? 0);
  });
  return { relevance, model: response.model, tokensIn: response.usage.input_tokens };
}

const THREAD_RELEVANCE = {
  note: SEARCH_NOTE,
  instructions: RELEVANCE_INSTRUCTIONS,
  criteria: RELEVANCE_CRITERIA,
  facts: { name: "thread", of: threadFacts },
} as const;

/** The exact body sent to `POST /v1/systemone`. Exported so callers can log or replay it. */
export function jevSearchRequest(
  query: string,
  candidates: readonly SearchCandidate[],
  options: { now: Date; model?: string },
) {
  return relevanceRequest(THREAD_RELEVANCE, query, candidates, options);
}

/**
 * Jev's probability, per candidate id, that the candidate is what the query looks for. A failed
 * call or a missing answer throws `JevError`; the caller decides what to show instead.
 */
export const judgeRelevance: (
  client: JevClient,
  query: string,
  candidates: readonly SearchCandidate[],
  options: { now: Date; signal?: AbortSignal },
) => Promise<{ relevance: Map<string, number>; model: string; tokensIn: number }> = async (
  client,
  query,
  candidates,
  options,
) => {
  const body = jevSearchRequest(query, candidates, { now: options.now, model: client.model });
  return judge(client, body, candidates, options.signal);
};

/** A Drive file a search found or a recent one, as the person would see it. */
export interface FileCandidate {
  /** Stable key, e.g. the node id. Never sent to the model. */
  id: string;
  name: string;
  /** Where it is: the workspace and drive, e.g. "Acme · Shared". */
  location: string;
  modifiedAt: Date;
  /** The start of the file's text. */
  excerpt: string;
}

function fileFacts(candidate: FileCandidate, now: Date) {
  return {
    name: candidate.name,
    location: candidate.location,
    modified: describeDate(candidate.modifiedAt, now),
    excerpt: truncateToTokens(candidate.excerpt, SEARCH_EXCERPT_TOKENS),
  };
}

const FILE_RELEVANCE = {
  note: FILE_SEARCH_NOTE,
  instructions: FILE_RELEVANCE_INSTRUCTIONS,
  criteria: FILE_RELEVANCE_CRITERIA,
  facts: { name: "file", of: fileFacts },
} as const;

/** The exact Drive relevance body sent to `POST /v1/systemone`. */
export function jevFileSearchRequest(
  query: string,
  candidates: readonly FileCandidate[],
  options: { now: Date; model?: string },
) {
  return relevanceRequest(FILE_RELEVANCE, query, candidates, options);
}

/** Jev's probability, per file id, that the file is what the query looks for. Throws `JevError`. */
export const judgeFileRelevance: (
  client: JevClient,
  query: string,
  candidates: readonly FileCandidate[],
  options: { now: Date; signal?: AbortSignal },
) => Promise<{ relevance: Map<string, number>; model: string; tokensIn: number }> = async (
  client,
  query,
  candidates,
  options,
) => {
  const body = jevFileSearchRequest(query, candidates, { now: options.now, model: client.model });
  return judge(client, body, candidates, options.signal);
};

/**
 * Most relevant first. Candidates Jev judged come first, by probability, with full-text order
 * breaking ties; candidates it didn't judge follow in full-text order. Input order is the
 * full-text order.
 */
export function rankByRelevance<T extends { id: string }>(
  candidates: readonly T[],
  relevance: ReadonlyMap<string, number>,
) {
  return candidates
    .map((candidate, order) => ({ candidate, order, p: relevance.get(candidate.id) }))
    .toSorted((a, b) => {
      if (a.p === undefined || b.p === undefined) {
        if (a.p !== b.p) return a.p === undefined ? 1 : -1;
        return a.order - b.order;
      }
      return b.p - a.p || a.order - b.order;
    })
    .map(({ candidate }) => candidate) satisfies T[];
}
