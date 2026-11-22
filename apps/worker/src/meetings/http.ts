import type { ErrorCode } from "@omni/contracts";
import { forMember, forUser, type MemberStorage } from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";

export const memberMeetings = (c: Context<AppEnv>) => forMember(c.var.db, c.var.member.id).meetings;
export const userMeetings = (c: Context<AppEnv>) => forUser(c.var.db, c.var.member.userId).meetings;
export const memberFiles: (c: Context<AppEnv>) => MemberStorage = (c) =>
  forMember(c.var.db, c.var.member.id).storage;

const FAILURES = {
  not_found: ["not_found", "not found"],
  forbidden: ["forbidden", "only the meeting's editors can do that"],
  consent_required: ["bad_request", "confirm everyone was told the meeting is recorded"],
  invalid_address: ["bad_request", "that is not an email address"],
  invalid_name: ["bad_request", "a name is 1 to 200 characters"],
  recording_elsewhere: ["conflict", "someone in your workspace is already recording this meeting"],
  decided: ["conflict", "that action was already decided"],
  not_a_recording: ["bad_request", "the recording must be a file in your My files"],
  not_stoppable: ["conflict", "the meeting is not recording"],
  not_retryable: ["conflict", "the meeting has not failed"],
} as const satisfies Record<string, readonly [ErrorCode, string]>;

export type MeetingsFailure = keyof typeof FAILURES;

/** The API's answer for a refusal. A meeting you cannot open is just not found. */
export function refused(c: Context<AppEnv>, result: { status: MeetingsFailure }) {
  const [code, message] = FAILURES[result.status];
  return apiError(c, code, message);
}

/** The folder in the recorder's My files that recordings go into, shared with nobody. */
export const RECORDINGS_FOLDER = "Recordings";
const FOLDER_PAGES = 20;

async function isPrivate(files: MemberStorage, folderId: string) {
  const shared = await files.sharing(folderId);
  return (
    shared.status === "ok" &&
    shared.sharing.people.length === 0 &&
    shared.sharing.linkAccess === "restricted"
  );
}

/** The recorder's private `Recordings` folder, made on first use. Null when Storage refuses. */
export async function recordingsFolder(files: MemberStorage) {
  let cursor = null;
  for (let page = 0; page < FOLDER_PAGES; page++) {
    const listed = await files.list({ space: "personal" }, { cursor, limit: 200 });
    if (listed.status !== "ok") return null;
    for (const node of listed.nodes) {
      if (
        node.kind === "folder" &&
        node.name === RECORDINGS_FOLDER &&
        (await isPrivate(files, node.id))
      ) {
        return node.id;
      }
    }
    if (listed.nodes.some((node) => node.kind === "file") || !listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  const made = await files.createFolder({ space: "personal" }, RECORDINGS_FOLDER);
  return made.status === "ok" ? made.node.id : null;
}

/** Wire form of a meeting row: dates as ISO strings. */
export const wire = <T extends { startedAt: Date; endedAt: Date | null }>(meeting: T) => ({
  ...meeting,
  startedAt: meeting.startedAt.toISOString(),
  endedAt: meeting.endedAt?.toISOString() ?? null,
});
