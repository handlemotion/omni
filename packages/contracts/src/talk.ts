import { z } from "zod";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime();

/** `docs/spec/talk.md`. */
export const TALK_BODY_MAX = 4_000;
export const TALK_PAGE_MAX = 100;

/** A teammate in `GET /api/talk/people`, with the thread between you if there is one. */
export const talkPersonSchema = z.object({
  memberId: id,
  name: z.string(),
  email: z.string(),
  /** Their picture's URL, or null for initials. */
  image: z.string().nullable(),
  /** Has Omni open in this workspace right now. */
  online: z.boolean(),
  threadId: id.nullable(),
  /** Their notes you have not read. */
  unread: z.number().int().nonnegative(),
  lastMessageAt: isoDate.nullable(),
});

export const talkPeopleResponseSchema = z.object({
  people: z.array(talkPersonSchema),
});

export const talkOpenThreadBodySchema = z.object({ memberId: id });

export const talkThreadSchema = z.object({ id, otherMemberId: id });
export const talkThreadResponseSchema = z.object({ thread: talkThreadSchema });

/**
 * A file dropped in a thread: a Drive file in the sender's My files, shared with the other one.
 * `nodeId` is null once it is deleted for good; opening it may also answer not found when it was
 * trashed or its share removed.
 */
export const talkFileSchema = z.object({
  nodeId: id.nullable(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
});

export const talkReactionSchema = z.object({
  emoji: z.string(),
  /** Who left it, first first. */
  memberIds: z.array(id),
});

export const talkMessageSchema = z.object({
  id,
  threadId: id,
  authorMemberId: id,
  body: z.string().nullable(),
  file: talkFileSchema.nullable(),
  reactions: z.array(talkReactionSchema),
  createdAt: isoDate,
});

/** `GET /threads/:id/messages?before=&limit=`: newest first. */
export const talkMessagesQuerySchema = z.object({
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(TALK_PAGE_MAX).optional(),
});

export const talkMessagesResponseSchema = z.object({
  thread: talkThreadSchema,
  messages: z.array(talkMessageSchema),
  /** Older notes remain: ask again with `before` set to the last one's id. */
  more: z.boolean(),
});

export const talkNoteBodySchema = z.object({ body: z.string().min(1).max(TALK_BODY_MAX) });

/** `POST /threads/:id/files?name=`: the bytes are the body. */
export const talkFileQuerySchema = z.object({ name: z.string().min(1).max(255) });

export const talkMessageResponseSchema = z.object({ message: talkMessageSchema });

/**
 * Realtime, on the workspace's socket (teammates only). `talk.online`: a teammate's first app
 * opened or their last one closed. `talk.message`: a note in one of your threads, yours from
 * another device included. `talk.changed`: a thread's reactions, or your own read, changed.
 * Refetch what they name.
 */
export const talkOnlineEventSchema = z.object({
  type: z.literal("talk.online"),
  memberId: id,
  online: z.boolean(),
});
export const talkMessageEventSchema = z.object({
  type: z.literal("talk.message"),
  threadId: id,
  messageId: id,
  fromMemberId: id,
  preview: z.string(),
});
export const talkChangedEventSchema = z.object({
  type: z.literal("talk.changed"),
  threadId: id,
});
export const talkEventSchema = z.discriminatedUnion("type", [
  talkOnlineEventSchema,
  talkMessageEventSchema,
  talkChangedEventSchema,
]);

export type TalkPerson = z.infer<typeof talkPersonSchema>;
export type TalkPeopleResponse = z.infer<typeof talkPeopleResponseSchema>;
export type TalkThread = z.infer<typeof talkThreadSchema>;
export type TalkThreadResponse = z.infer<typeof talkThreadResponseSchema>;
export type TalkFile = z.infer<typeof talkFileSchema>;
export type TalkReaction = z.infer<typeof talkReactionSchema>;
export type TalkMessage = z.infer<typeof talkMessageSchema>;
export type TalkMessagesResponse = z.infer<typeof talkMessagesResponseSchema>;
export type TalkMessageResponse = z.infer<typeof talkMessageResponseSchema>;
export type TalkEvent = z.infer<typeof talkEventSchema>;
