import {
  storageEmailSchema,
  storagePageQuerySchema,
  storagePutPersonBodySchema,
  storageSetLinkBodySchema,
  type StorageSharedWithMeResponse,
  type StorageSharing,
  type StorageSharingResponse,
} from "@omni/contracts";
import { forUser, type StorageNode, type StorageSharing as SharingRow } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { systemMailSender, type AppEnv } from "../context.ts";
import { checkRateLimit, tooManyRequests } from "../rate-limiter.ts";
import { wireNode } from "./core.ts";
import { zValidator } from "../validator.ts";
import { decodeCursor, encodeCursor, memberStorage, refused } from "./http.ts";

const sharedCursor = z.object({ sharedAt: z.coerce.date(), id: z.string().min(1) });

const wirePerson = <T extends { createdAt: Date }>(person: T) => ({
  ...person,
  createdAt: person.createdAt.toISOString(),
});

function answer(c: Context<AppEnv>, sharing: SharingRow) {
  const wire: StorageSharing = {
    ...sharing,
    people: sharing.people.map(wirePerson),
    inherited: sharing.inherited.map(wirePerson),
  };
  return c.json({ sharing: wire } satisfies StorageSharingResponse);
}

function emailParam(c: Context<AppEnv>) {
  const parsed = storageEmailSchema.safeParse(c.req.param("email"));
  return parsed.success ? parsed.data : null;
}

async function sendShareMail(c: Context<AppEnv>, to: string, node: StorageNode, shareId: string) {
  const { config, user, log } = c.var;
  if (!config.SYSTEM_MAIL_FROM) {
    log.warn("storage.share_mail_skipped", { reason: "SYSTEM_MAIL_FROM is not set" });
    return;
  }
  const appName = config.auth.appName;
  const url = new URL(`/s/${shareId}`, config.auth.webAppURL);
  await systemMailSender({ email: c.env.EMAIL, config, log })({
    to,
    subject: `${user.email} shared "${node.name}" with you on ${appName}`,
    text: [
      `${user.email} shared "${node.name}" with you on ${appName}.`,
      "",
      "Open this link to see it:",
      "",
      url.toString(),
      "",
      `Sign in with ${to} to open it. If you did not expect it, ignore this email.`,
    ].join("\n"),
  });
}

export const storageSharing = new Hono<AppEnv>()
  .get("/nodes/:id/sharing", async (c) => {
    const found = await memberStorage(c).sharing(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found.status);
    return answer(c, found.sharing);
  })

  .put("/nodes/:id/sharing/link", zValidator("json", storageSetLinkBodySchema), async (c) => {
    const body = c.req.valid("json");
    const id = c.req.param("id");
    const changed =
      "reset" in body
        ? await memberStorage(c).resetLink(id)
        : await memberStorage(c).setLinkAccess(id, body.linkAccess);
    if (changed.status !== "ok") return refused(c, changed.status);
    return answer(c, changed.sharing);
  })

  .put(
    "/nodes/:id/sharing/people/:email",
    zValidator("json", storagePutPersonBodySchema),
    async (c) => {
      const files = memberStorage(c);
      const id = c.req.param("id");
      const email = emailParam(c);
      if (!email) return refused(c, "invalid_email");
      const before = await files.sharing(id);
      if (before.status !== "ok") return refused(c, before.status);
      if (!before.sharing.people.some((person) => person.email === email)) {
        const wait = await checkRateLimit(c.env, c.var.config, "storageShare", c.var.member.id);
        if (wait) return tooManyRequests(c, wait, "storageShare");
      }
      const put = await files.putGrant(id, email, c.req.valid("json").role);
      if (put.status !== "ok") return refused(c, put.status);
      if (put.created) {
        try {
          await sendShareMail(c, email, put.node, put.shareId);
        } catch (error) {
          await files.removeGrant(id, email);
          throw error;
        }
      }
      const after = await files.sharing(id);
      if (after.status !== "ok") return refused(c, after.status);
      return answer(c, after.sharing);
    },
  )

  .delete("/nodes/:id/sharing/people/:email", async (c) => {
    const files = memberStorage(c);
    const id = c.req.param("id");
    const email = emailParam(c);
    if (!email) return refused(c, "invalid_email");
    const removed = await files.removeGrant(id, email);
    if (removed.status !== "ok") return refused(c, removed.status);
    const after = await files.sharing(id);
    if (after.status !== "ok") return refused(c, after.status);
    return answer(c, after.sharing);
  })

  .get("/shared-with-me", zValidator("query", storagePageQuerySchema), async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const { db, user } = c.var;
    const page = await forUser(db, user.id, user.scopeOrgId).storage.sharedWithMe({
      cursor: decodeCursor(cursor, sharedCursor),
      limit,
    });
    return c.json({
      items: page.items.map((item) => ({
        ...item,
        node: wireNode(item.node),
        sharedAt: item.sharedAt.toISOString(),
      })),
      nextCursor: encodeCursor(page.nextCursor),
    } satisfies StorageSharedWithMeResponse);
  });
