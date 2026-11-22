import { forMember, meetingsPipeline, type Db, type MemberStorage } from "@omni/db";
import { formatClock } from "@omni/ai";
import type { Config } from "../env.ts";
import { createLogger, type Logger } from "../log.ts";
import { createDoc, editDoc } from "../storage/docs.ts";
import type { WriteDeps } from "../storage/doc-write.ts";
import { recordingsFolder } from "./http.ts";

/** Writes one meeting's notes into its doc. Ids only. */
export type MeetingDocJob = { kind: "meeting-doc"; meetingId: string; orgId: string };

/** How long after the write step's hand-off the doc job looks for the notes. */
export const DOC_DELAY_SECONDS = 10;
const NAME_TRIES = 5;
/** How long one run holds the right to write a meeting's doc. */
export const DOC_LEASE_MS = 2 * 60_000;

/** A failure worth trying again: Storage was busy or refused for now. */
export class DocRetry extends Error {}

type Target = NonNullable<Awaited<ReturnType<ReturnType<typeof meetingsPipeline>["docTarget"]>>>;
type Notes = NonNullable<Target["notes"]>;

/** Queues the doc write for a meeting whose notes are about to be saved. */
export function enqueueNotesDoc(env: Env, meeting: { id: string; orgId: string }) {
  return env.AI_QUEUE.send(
    { kind: "meeting-doc", meetingId: meeting.id, orgId: meeting.orgId } satisfies MeetingDocJob,
    { delaySeconds: DOC_DELAY_SECONDS },
  );
}

/** The meeting's page, as the doc links to it. */
export function meetingUrl(config: Config, slug: string, meetingId: string) {
  const base = config.auth.webAppURL ?? config.auth.baseURL;
  return new URL(
    `/${encodeURIComponent(slug)}/meetings/${encodeURIComponent(meetingId)}`,
    base,
  ).toString();
}

const linkText = (text: string) => text.replace(/[[\]\\]/g, (ch) => `\\${ch}`);
const day = (date: Date) => date.toISOString().slice(0, 10);

/** True when the doc already holds this meeting's block: a line of Omni's that links to it. */
export function holdsBlock(markdown: string, url: string) {
  return markdown.split("\n").some((line) => line.includes(`](${url})`) && line.includes("Omni"));
}

function byline(target: Target, url: string) {
  const title = linkText(target.meeting.title ?? "this meeting");
  const by = target.recorderName ? `, recorded by ${target.recorderName}` : "";
  return `[${title}](${url})${by} on ${day(target.meeting.startedAt)}`;
}

const actionLine = (kind: string, payload: Record<string, unknown>) => {
  if (kind === "email") {
    const to = Array.isArray(payload.to) ? payload.to.join(", ") : "";
    return `- [ ] Send the follow-up email to ${to} (a draft is on the meeting's page)`;
  }
  const extra = [payload.owner, payload.due].filter((v) => typeof v === "string" && v);
  return `- [ ] ${String(payload.title ?? "")}${extra.length ? ` (${extra.join(", ")})` : ""}`;
};

/** The block the notes go in as, above what people typed. */
export function notesBlock(
  target: Target,
  notes: Notes,
  actions: Array<{ kind: string; payload: Record<string, unknown> }>,
  url: string,
) {
  const lines = [`_Written by Omni from the recording of ${byline(target, url)}._`, ""];
  if (notes.summary) lines.push("### Summary", "", notes.summary, "");
  if (notes.highlights.length) {
    lines.push("### Highlights", "");
    for (const h of notes.highlights) lines.push(`- **${formatClock(h.atMs)}** ${h.text}`);
    lines.push("");
  }
  if (actions.length) {
    lines.push("### Actions", "");
    for (const a of actions) lines.push(actionLine(a.kind, a.payload));
    lines.push("");
  }
  lines.push("---");
  return lines.join("\n");
}

/** What the doc gets instead when someone could open it who cannot open the meeting. */
export const linkBlock = (target: Target, url: string) =>
  `_Omni's notes from the recording of ${byline(target, url)} are on the meeting's page._\n\n---`;

async function audienceFits(files: MemberStorage, nodeId: string, granted: Set<string>) {
  const found = await files.node(nodeId);
  if (!found || found.inTrash || found.node.space !== "personal") return false;
  const shared = await files.sharing(nodeId);
  if (shared.status !== "ok") return false;
  const people = [...shared.sharing.people, ...shared.sharing.inherited];
  if (!people.every((p) => granted.has(p.email.toLowerCase()))) return false;
  const chain = new Set([nodeId, ...found.path.map((entry) => entry.id)]);
  for (const id of chain) {
    const link = id === nodeId ? shared : await files.sharing(id);
    if (link.status !== "ok" || link.sharing.linkAccess !== "restricted") return false;
  }
  return true;
}

const TITLE_IN_NAME_MAX = 200;

/** The notes doc's name: the meeting's title made safe for Drive, the date, and a number on a clash. */
export function docName(title: string | null, startedAt: Date, n: number) {
  const safe = (title ?? "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f\u007f]+/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_IN_NAME_MAX)
    .trim();
  const base = `${safe || "Meeting"} notes, ${day(startedAt)}`;
  return n ? `${base} (${n + 1})` : base;
}

async function docOf(deps: WriteDeps, files: MemberStorage, target: Target) {
  if (target.meeting.notesNodeId) return target.meeting.notesNodeId;
  const folderId = await recordingsFolder(files);
  if (!folderId) throw new DocRetry("the recorder's My files could not be reached");
  const pipeline = meetingsPipeline(deps.db);
  for (let n = 0; n < NAME_TRIES; n++) {
    const made = await createDoc(deps, files, target.meeting.orgId, {
      place: { parentId: folderId },
      name: docName(target.meeting.title, target.meeting.startedAt, n),
      markdown: "",
    });
    if (made.status === "refused" && made.reason === "name_taken") continue;
    if (made.status !== "ok") return null;
    if (await pipeline.claimNotesDoc(target.meeting.id, made.node.id)) return made.node.id;
    await files.trash(made.node.id);
    return (await pipeline.docTarget(target.meeting.id))?.meeting.notesNodeId ?? null;
  }
  return null;
}

/**
 * Writes the meeting's notes into its doc, once (`docs/spec/meetings.md`, "The notes"). Safe to
 * run any number of times: the doc is claimed once, a doc that already holds the block keeps it,
 * and the notes row says when it was written. `wait` while the notes are not saved yet.
 */
export async function writeNotesDoc(deps: WriteDeps, meetingId: string) {
  const pipeline = meetingsPipeline(deps.db);
  const target = await pipeline.docTarget(meetingId);
  if (!target) return "gone" as const;
  const { meeting, notes } = target;
  if (!notes) return meeting.status === "writing" ? ("wait" as const) : ("gone" as const);
  if (!(await pipeline.claimDocLease(meetingId, DOC_LEASE_MS))) return "held" as const;
  try {
    return await writeHeld(deps, target);
  } catch (error) {
    await pipeline.releaseDocLease(meetingId);
    throw error;
  }
}

async function writeHeld(deps: WriteDeps, target: Target) {
  const { meeting, notes, actions } = target;
  if (!notes) return "gone" as const;
  const meetingId = meeting.id;
  const empty = !notes.summary && !notes.highlights.length && !actions.length;
  if (empty || !meeting.recordedByMemberId) return "done" as const;
  const files = forMember(deps.db, meeting.recordedByMemberId).storage;
  const docId = await docOf(deps, files, target);
  if (!docId) {
    deps.log.warn("meetings.doc_unavailable", { meetingId });
    return "done" as const;
  }
  const url = meetingUrl(deps.config, target.workspaceSlug, meetingId);
  const block = (await audienceFits(files, docId, new Set(target.granted)))
    ? notesBlock(target, notes, actions, url)
    : linkBlock(target, url);
  const edited = await editDoc(deps, files, docId, (markdown) =>
    holdsBlock(markdown, url)
      ? { ok: false, error: "written" }
      : { ok: true, markdown: markdown.trim() ? `${block}\n\n${markdown}` : `${block}\n` },
  );
  if (edited.status === "version_conflict") throw new DocRetry("the doc changed while writing");
  if (edited.status !== "ok" && edited.status !== "invalid") {
    deps.log.warn("meetings.doc_refused", { meetingId, reason: edited.status });
  }
  return "done" as const;
}

/** Runs a `meeting-doc` job and settles its message, retrying while the notes are on their way. */
export async function consumeMeetingDocMessage(
  run: { env: Env; db: Db; config: Config; queue: string },
  message: Message<{ kind: string; orgId: string }>,
  maxRetries: number,
) {
  const job = message.body as MeetingDocJob;
  if (typeof job.meetingId !== "string") return message.ack();
  const log: Logger = createLogger({
    component: "queue",
    queue: run.queue,
    orgId: job.orgId,
    meetingId: job.meetingId,
    step: "doc",
  });
  const pending: Promise<unknown>[] = [];
  const deps: WriteDeps = {
    env: run.env,
    db: run.db,
    config: run.config,
    log,
    waitUntil: (work) => pending.push(work),
  };
  try {
    const outcome = await writeNotesDoc(deps, job.meetingId);
    await Promise.allSettled(pending);
    if (outcome === "wait" && message.attempts <= maxRetries) {
      return message.retry({ delaySeconds: DOC_DELAY_SECONDS * message.attempts });
    }
    if (outcome === "held" && message.attempts <= maxRetries) {
      return message.retry({ delaySeconds: DOC_LEASE_MS / 1000 + DOC_DELAY_SECONDS });
    }
    log.info("meetings.doc", { outcome });
    return message.ack();
  } catch (error) {
    await Promise.allSettled(pending);
    if (message.attempts <= maxRetries) {
      log.warn("meetings.doc_failed", { error, attempts: message.attempts });
      return message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
    }
    log.error("meetings.doc_gave_up", { error });
    return message.ack();
  }
}
