import type { Db } from "./client.ts";
import { asTalkMember, isTeammateRole } from "./talk/core.ts";
import { fileOfMessage, listMessages, react, recordFile, sendNote } from "./talk/messages.ts";
import { getThread, listPeople, openThread, readThread } from "./talk/threads.ts";

export { NO_TALK, type NoTalk, type TalkMember } from "./talk/core.ts";
export {
  isEmoji,
  previewOf,
  TALK_BODY_MAX,
  TALK_PAGE_MAX,
  TALK_PREVIEW_MAX,
  TALK_REACTIONS_PER_PERSON,
  type ReactResult,
  type SendResult,
  type TalkFile,
  type TalkMessage,
  type TalkReaction,
} from "./talk/messages.ts";
export type { OpenThreadResult, TalkPerson } from "./talk/threads.ts";

/** Whether a member with these roles is a teammate Talk is open to (not a freelancer alone). */
export const talkRole = isTeammateRole;

/**
 * The member door to Talk (`docs/spec/talk.md`): the teammate's direct threads with the others
 * in their workspace. Only the two in a thread reach it; anything else is `not_found`. A
 * freelancer or a Personal space gets `no_talk`.
 */
export function memberTalk(db: Db, memberId: string) {
  return {
    people: () => asTalkMember(db, memberId, (me) => listPeople(db, me)),
    openThread: (otherMemberId: string) =>
      asTalkMember(db, memberId, (me) => openThread(db, me, otherMemberId)),
    thread: (threadId: string) => asTalkMember(db, memberId, (me) => getThread(db, me, threadId)),
    messages: (threadId: string, page: { before?: string | null; limit?: number } = {}) =>
      asTalkMember(db, memberId, (me) => listMessages(db, me, threadId, page)),
    sendNote: (threadId: string, body: string) =>
      db.transaction((tx) => asTalkMember(tx, memberId, (me) => sendNote(tx, me, threadId, body))),
    recordFile: (threadId: string, file: Parameters<typeof recordFile>[3]) =>
      db.transaction((tx) =>
        asTalkMember(tx, memberId, (me) => recordFile(tx, me, threadId, file)),
      ),
    fileOf: (messageId: string) =>
      asTalkMember(db, memberId, (me) => fileOfMessage(db, me, messageId)),
    read: (threadId: string) => asTalkMember(db, memberId, (me) => readThread(db, me, threadId)),
    react: (messageId: string, emoji: string, on: boolean) =>
      db.transaction((tx) =>
        asTalkMember(tx, memberId, (me) => react(tx, me, messageId, emoji, on)),
      ),
  };
}

export type MemberTalk = ReturnType<typeof memberTalk>;
