import type { TalkEvent, TalkFile, TalkMessage, TalkReaction } from "@omni/contracts";

export const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isText = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTalkReactions = (value: unknown): value is TalkReaction[] =>
  Array.isArray(value) &&
  value.every(
    (r) => isObject(r) && isText(r.emoji) && Array.isArray(r.memberIds) && r.memberIds.every(isId),
  );

const isTalkFile = (value: unknown): value is TalkFile =>
  isObject(value) &&
  (value.nodeId === null || isId(value.nodeId)) &&
  isText(value.name) &&
  typeof value.size === "number" &&
  (value.mimeType === null || isText(value.mimeType));

const isTalkMessage = (value: unknown): value is TalkMessage =>
  isObject(value) &&
  isId(value.id) &&
  isId(value.threadId) &&
  isId(value.authorMemberId) &&
  (value.body === null || isText(value.body)) &&
  (value.file === null || isTalkFile(value.file)) &&
  isTalkReactions(value.reactions) &&
  isText(value.createdAt);

const parseTalkChanged = (threadId: string, event: Record<string, unknown>) => {
  const { read, readAt, reactions } = event;
  const changed: Extract<TalkEvent, { type: "talk.changed" }> = { type: "talk.changed", threadId };
  if (read === true) changed.read = true;
  if (read === true && isText(readAt)) changed.readAt = readAt;
  if (isObject(reactions) && isId(reactions.messageId) && isTalkReactions(reactions.reactions)) {
    const version = typeof reactions.version === "number" ? { version: reactions.version } : {};
    changed.reactions = {
      messageId: reactions.messageId,
      reactions: reactions.reactions,
      ...version,
    };
  }
  return changed;
};

/** A `talk.*` event off the socket, or undefined when it is not one this client knows. */
export const parseTalkEvent: (event: Record<string, unknown>) => TalkEvent | undefined = (
  event,
) => {
  const { type, memberId, online, threadId, messageId, fromMemberId, preview, message } = event;
  if (type === "talk.online" && isId(memberId) && typeof online === "boolean") {
    return { type, memberId, online };
  }
  if (type === "talk.changed" && isId(threadId)) return parseTalkChanged(threadId, event);
  if (
    type === "talk.message" &&
    isId(threadId) &&
    isId(messageId) &&
    isId(fromMemberId) &&
    typeof preview === "string"
  ) {
    const carried = isTalkMessage(message) && message.id === messageId ? { message } : {};
    return { type, threadId, messageId, fromMemberId, preview, ...carried };
  }
  return undefined;
};
