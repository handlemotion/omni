import { setThreadArchived, threadActionTargets } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";
import { enqueuePerFolder, idempotencyHeader, notFound } from "./mail.ts";

type Kind = "trash" | "spam" | "not_spam";

const MOVES: Record<Kind, (role: string) => boolean> = {
  trash: (role) => role !== "trash",
  spam: (role) => role !== "junk" && role !== "sent",
  not_spam: (role) => role === "junk",
};

async function move(c: Context<AppEnv>, threadId: string, kind: Kind, key: string) {
  const found = await threadActionTargets(c.var.db, c.var.member.id, threadId);
  if (!found) notFound();
  await setThreadArchived(c.var.db, c.var.member.id, threadId, kind !== "not_spam");
  const actionIds = await enqueuePerFolder(
    c,
    found,
    key,
    found.targets
      .filter(({ role }) => MOVES[kind](role))
      .map(({ role: _role, ...target }) => ({ kind, payload: target })),
  );
  return c.json({ actionIds });
}

const guards = () => [limitPerMember("actions"), zValidator("header", idempotencyHeader)] as const;

export const folders = new Hono<AppEnv>()
  .post("/threads/:id/trash", ...guards(), (c) =>
    move(c, c.req.param("id"), "trash", c.req.valid("header")["idempotency-key"]),
  )
  .post("/threads/:id/spam", ...guards(), (c) =>
    move(c, c.req.param("id"), "spam", c.req.valid("header")["idempotency-key"]),
  )
  .post("/threads/:id/not-spam", ...guards(), (c) =>
    move(c, c.req.param("id"), "not_spam", c.req.valid("header")["idempotency-key"]),
  );
