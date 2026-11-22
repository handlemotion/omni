import {
  talkMessagesQuerySchema,
  talkNoteBodySchema,
  talkOpenThreadBodySchema,
  type TalkMessageResponse,
  type TalkMessagesResponse,
  type TalkPeopleResponse,
  type TalkThreadResponse,
} from "@omni/contracts";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { talkFiles } from "./files.ts";
import { announce, deliver, memberTalk, refused, wireMessage } from "./http.ts";

/** `/api/talk`: direct threads between teammates (`docs/spec/talk.md`). */
export const talk = new Hono<AppEnv>()
  .get("/people", async (c) => {
    const listed = await memberTalk(c).people();
    if (listed.status !== "ok") return refused(c, listed);
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.var.member.orgId));
    const online = new Set(await stub.online());
    return c.json({
      people: listed.people.map((person) => ({
        ...person,
        online: online.has(person.memberId),
        lastMessageAt: person.lastMessageAt?.toISOString() ?? null,
      })),
    } satisfies TalkPeopleResponse);
  })

  .post("/threads", zValidator("json", talkOpenThreadBodySchema), async (c) => {
    const opened = await memberTalk(c).openThread(c.req.valid("json").memberId);
    if (opened.status !== "ok") return refused(c, opened);
    return c.json(
      { thread: opened.thread } satisfies TalkThreadResponse,
      opened.created ? 201 : 200,
    );
  })

  .get("/threads/:id/messages", zValidator("query", talkMessagesQuerySchema), async (c) => {
    const page = await memberTalk(c).messages(c.req.param("id"), c.req.valid("query"));
    if (page.status !== "ok") return refused(c, page);
    return c.json({
      thread: page.thread,
      messages: page.messages.map(wireMessage),
      more: page.more,
    } satisfies TalkMessagesResponse);
  })

  .post("/threads/:id/messages", zValidator("json", talkNoteBodySchema), async (c) => {
    const sent = await memberTalk(c).sendNote(c.req.param("id"), c.req.valid("json").body);
    if (sent.status !== "ok") return refused(c, sent);
    deliver(c, sent.thread, sent.message);
    return c.json({ message: wireMessage(sent.message) } satisfies TalkMessageResponse, 201);
  })

  .put("/threads/:id/read", async (c) => {
    const read = await memberTalk(c).read(c.req.param("id"));
    if (read.status !== "ok") return refused(c, read);
    c.executionCtx.waitUntil(
      announce(c, [c.var.member.id], {
        type: "talk.changed",
        threadId: c.req.param("id"),
        read: true,
        readAt: read.readAt.toISOString(),
      }),
    );
    return c.body(null, 204);
  })

  .put("/messages/:id/reactions/:emoji", (c) => reaction(c, true))
  .delete("/messages/:id/reactions/:emoji", (c) => reaction(c, false))

  .route("/", talkFiles);

async function reaction(c: Context<AppEnv>, on: boolean) {
  const emoji = decodeURIComponent(c.req.param("emoji") ?? "");
  const done = await memberTalk(c).react(c.req.param("id") ?? "", emoji, on);
  if (done.status !== "ok") return refused(c, done);
  c.executionCtx.waitUntil(
    announce(c, [c.var.member.id, done.thread.otherMemberId], {
      type: "talk.changed",
      threadId: done.thread.id,
      reactions: {
        messageId: c.req.param("id") ?? "",
        reactions: done.reactions,
        version: done.reactionsVersion,
      },
    }),
  );
  return c.body(null, 204);
}
