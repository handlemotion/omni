import type { Db } from "./client.ts";
import { resolveStart, type StartRecording } from "./meetings/bind.ts";
import { memberActor, userActor, type MeetingsActor } from "./meetings/core.ts";
import {
  meetingOfTask,
  meetingsOn,
  setRecord,
  takeOff,
  type MeetingRecord,
  type MeetingsOnQuery,
} from "./meetings/crm.ts";
import { findMeetings, type MeetingsFilter } from "./meetings/find.ts";
import * as pipeline from "./meetings/pipeline.ts";
import {
  getAction,
  getMeeting,
  getTranscript,
  groupDigest,
  listGroups,
  listMeetings,
  saveGroupSummary,
  searchMeetings,
} from "./meetings/read.ts";
import {
  changeMeeting,
  decideAction,
  deleteMeeting,
  grantMeeting,
  renameSpeaker,
  revokeMeeting,
  startMeeting,
  type MeetingChange,
} from "./meetings/write.ts";

export {
  FORBIDDEN as MEETINGS_FORBIDDEN,
  groupKeyFor,
  NOT_FOUND as MEETINGS_NOT_FOUND,
  WEBMAIL,
  type MeetingRole,
} from "./meetings/core.ts";
export { MEETINGS_PAGE_MAX, type MeetingView } from "./meetings/read.ts";
export type { MeetingRecord, MeetingRecordKind, MeetingsOnQuery } from "./meetings/crm.ts";
export type { MeetingsFilter } from "./meetings/find.ts";
export type { MeetingChange, StartMeeting } from "./meetings/write.ts";
export { recurrenceKey, type MeetingEventChoice, type StartRecording } from "./meetings/bind.ts";
export type {
  MeetingStatus,
  SavedNotes,
  SavedTranscript,
  StoppedRecording,
} from "./meetings/pipeline.ts";

const doors = (db: Db, actorOf: () => Promise<MeetingsActor | null>) => ({
  get: async (meetingId: string) => getMeeting(db, await actorOf(), meetingId),
  transcript: async (meetingId: string) => getTranscript(db, await actorOf(), meetingId),
  list: async (page: Parameters<typeof listMeetings>[2] = {}) =>
    listMeetings(db, await actorOf(), page),
  search: async (query: string, limit?: number) =>
    searchMeetings(db, await actorOf(), query, limit),
});

/**
 * The member door to Meetings (`docs/spec/meetings.md`, "Sharing"): the meetings of their
 * workspace they recorded, were granted by address, or that are open to the workspace (never to a
 * freelancer that way). A meeting they cannot open answers `not_found`.
 */
export function memberMeetings(db: Db, memberId: string) {
  const actor = () => memberActor(db, memberId);
  return {
    ...doors(db, actor),
    groups: async (page: Parameters<typeof listGroups>[2] = {}) =>
      listGroups(db, await actor(), page),
    groupDigest: async (groupKey: string, limit?: number) =>
      groupDigest(db, await actor(), groupKey, limit),
    find: async (filter: MeetingsFilter) => findMeetings(db, await actor(), filter),
    action: async (actionId: string) => getAction(db, await actor(), actionId),
    on: async (query: MeetingsOnQuery) => meetingsOn(db, await actor(), query),
    setRecord: async (meetingId: string, record: MeetingRecord | null) =>
      setRecord(db, await actor(), meetingId, record),
    taskMeeting: async (taskId: string) => meetingOfTask(db, await actor(), taskId),
    takeOff: async (meetingId: string, from: MeetingRecord) =>
      takeOff(db, await actor(), meetingId, from),
    start: async (input: StartRecording) => {
      const resolved = await resolveStart(db, memberId, input);
      if (resolved.status !== "ok") return resolved;
      return db.transaction(async (tx) => {
        const me = await memberActor(tx, memberId);
        return me ? startMeeting(tx, me, resolved.start) : ({ status: "not_found" } as const);
      });
    },
    change: async (meetingId: string, change: MeetingChange) =>
      changeMeeting(db, await actor(), meetingId, change),
    grant: async (meetingId: string, address: string, role: "viewer" | "editor") =>
      grantMeeting(db, await actor(), meetingId, address, role),
    revoke: async (meetingId: string, address: string) =>
      revokeMeeting(db, await actor(), meetingId, address),
    renameSpeaker: async (
      meetingId: string,
      label: string,
      who: { name: string; address: string | null },
    ) => renameSpeaker(db, await actor(), meetingId, label, who),
    decideAction: async (actionId: string, decision: { accept: boolean; taskId?: string | null }) =>
      decideAction(db, await actor(), actionId, decision),
    remove: (meetingId: string) =>
      db.transaction(async (tx) => deleteMeeting(tx, await memberActor(tx, memberId), meetingId)),
  };
}

/** The user door: meetings shared with one of the person's verified addresses, in any workspace or one. */
export function userMeetings(db: Db, userId: string, scopeOrgId?: string | null) {
  return doors(db, () => userActor(db, userId, scopeOrgId ?? null));
}

/**
 * Trusted writers for the Worker's pipeline jobs, which act for the workspace, not a person.
 * Every one is safe to run twice. Never reachable from a member's request.
 */
export function meetingsPipeline(db: Db) {
  return {
    advance: (
      ...a: Parameters<typeof pipeline.advance> extends [unknown, ...infer R] ? R : never
    ) => pipeline.advance(db, ...a),
    stopRecording: (meetingId: string, stop: pipeline.StoppedRecording) =>
      db.transaction((tx) => pipeline.stopRecording(tx, meetingId, stop)),
    claimSubmission: (meetingId: string) => pipeline.claimSubmission(db, meetingId),
    releaseSubmission: (meetingId: string) => pipeline.releaseSubmission(db, meetingId),
    setUpload: (meetingId: string, uploadId: string) => pipeline.setUpload(db, meetingId, uploadId),
    setEngineJob: (meetingId: string, provider: string, jobId: string) =>
      pipeline.setEngineJob(db, meetingId, provider, jobId),
    countPoll: (meetingId: string) => pipeline.countPoll(db, meetingId),
    failedAttempt: (meetingId: string) => pipeline.failedAttempt(db, meetingId),
    succeeded: (meetingId: string) => pipeline.succeeded(db, meetingId),
    fail: (meetingId: string, failure: string, from: pipeline.MeetingStatus[]) =>
      pipeline.fail(db, meetingId, failure, from),
    meeting: (meetingId: string) => pipeline.meetingForJob(db, meetingId),
    saveTranscript: (meetingId: string, orgId: string, saved: pipeline.SavedTranscript) =>
      db.transaction((tx) => pipeline.saveTranscript(tx, meetingId, orgId, saved)),
    nameSpeakers: (meetingId: string, named: Parameters<typeof pipeline.nameSpeakers>[2]) =>
      pipeline.nameSpeakers(db, meetingId, named),
    saveNotes: (meetingId: string, orgId: string, notes: pipeline.SavedNotes) =>
      db.transaction((tx) => pipeline.saveNotes(tx, meetingId, orgId, notes)),
    claimDocWrite: (meetingId: string) => pipeline.claimDocWrite(db, meetingId),
    audience: (meetingId: string) => pipeline.memberAudience(db, meetingId),
    stalled: (olderThanMs: number) => pipeline.stalled(db, olderThanMs),
    nudged: (meetingId: string) => pipeline.nudged(db, meetingId),
    restartFailed: (meetingId: string) =>
      db.transaction((tx) => pipeline.restartFailed(tx, meetingId)),
    setFiles: (meetingId: string, files: { notesNodeId?: string; groupKey?: string }) =>
      pipeline.setFiles(db, meetingId, files),
    saveGroupSummary: (
      ...a: Parameters<typeof saveGroupSummary> extends [unknown, ...infer R] ? R : never
    ) => saveGroupSummary(db, ...a),
  };
}

export type MemberMeetings = ReturnType<typeof memberMeetings>;
