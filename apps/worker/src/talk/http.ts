import type { ErrorCode, TalkEvent, TalkMessage as WireMessage } from "@omni/contracts";
import { forMember, previewOf, type MemberTalk, type TalkMessage } from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { pushToMembers } from "../realtime.ts";

export const memberTalk: (c: Context<AppEnv>) => MemberTalk = (c) =>
  forMember(c.var.db, c.var.member.id).talk;

const FAILURES = {
  no_talk: ["not_found", "not found"],
  not_found: ["not_found", "not found"],
  invalid_body: ["bad_request", "a note is 1 to 4,000 characters"],
  invalid_emoji: ["bad_request", "a reaction is one emoji"],
  too_many_reactions: ["conflict", "that note has as many of your reactions as it takes"],
} as const satisfies Record<string, readonly [ErrorCode, string]>;

/** The API's answer for a refusal from Talk's door. A thread you are not in is just not found. */
export function refused(c: Context<AppEnv>, result: { status: keyof typeof FAILURES }) {
  const [code, message] = FAILURES[result.status];
  return apiError(c, code, message);
}

export const wireMessage = (message: TalkMessage) =>
  ({ ...message, createdAt: message.createdAt.toISOString() }) satisfies WireMessage;

const realtime = (c: Context<AppEnv>) =>
  c.env.REALTIME.get(c.env.REALTIME.idFromName(c.var.member.orgId));

/** Tells these members' Talk apps; returns those with none open. */
export async function announce(c: Context<AppEnv>, memberIds: string[], event: TalkEvent) {
  return realtime(c).talk(memberIds, event);
}

/**
 * Delivers a new note: both members' apps hear it (the sender's other devices too), and the
 * recipient, when no app of theirs is open, gets a push.
 */
export async function deliver(
  c: Context<AppEnv>,
  thread: { id: string; otherMemberId: string },
  message: TalkMessage,
) {
  const preview = previewOf(message);
  const offline = await announce(c, [c.var.member.id, thread.otherMemberId], {
    type: "talk.message",
    threadId: thread.id,
    messageId: message.id,
    fromMemberId: c.var.member.id,
    preview,
  });
  const away = offline.filter((id) => id === thread.otherMemberId);
  if (away.length === 0 || !c.var.config.EXPO_PUSH_ENABLED) return;
  c.executionCtx.waitUntil(
    pushToMembers(c.var.db, c.var.config, away, {
      title: c.var.user.email,
      body: preview,
    }),
  );
}
