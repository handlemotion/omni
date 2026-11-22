import { createMiddleware } from "hono/factory";
import { hashLinkPassword } from "@omni/crypto";
import {
  storageEmailSchema,
  storagePageQuerySchema,
  storagePutPersonBodySchema,
  storageSetLinkBodySchema,
  storageSetPolicyBodySchema,
  type StoragePolicyResponse,
  type StorageSharedWithMeResponse,
  type StorageSharing,
  type StorageSharingResponse,
} from "@omni/contracts";
import {
  forUser,
  schema,
  type StorageLinkSettings,
  type StorageNode,
  type StorageSharing as SharingRow,
} from "@omni/db";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { entitlements } from "../billing.ts";
import { systemMailSender, type AppEnv } from "../context.ts";
import { checkRateLimit, longestWait, tooManyRequests } from "../rate-limiter.ts";
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
    link: { ...sharing.link, expiresAt: sharing.link.expiresAt?.toISOString() ?? null },
    people: sharing.people.map(wirePerson),
    inherited: sharing.inherited.map(wirePerson),
  };
  return c.json({ sharing: wire } satisfies StorageSharingResponse);
}

function emailParam(c: Context<AppEnv>) {
  const parsed = storageEmailSchema.safeParse(c.req.param("email"));
  return parsed.success ? parsed.data : null;
}

const NEW_ACCOUNT_DAYS = 7;
const MAIL_NAME_CHARS = 40;

/** The name as a share mail quotes it: one line, cut short. */
export function mailName(name: string) {
  const line = name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const chars = [...line];
  return chars.length > MAIL_NAME_CHARS ? `${chars.slice(0, MAIL_NAME_CHARS - 1).join("")}…` : line;
}

async function onProbation(c: Context<AppEnv>) {
  const { db, config, user, member } = c.var;
  const [row] = await db
    .select({ createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, user.id));
  if (!row || Date.now() - row.createdAt.getTime() < NEW_ACCOUNT_DAYS * 86_400_000) return true;
  const plan = await entitlements(db, config, member.orgId);
  return plan.enabled && plan.readOnly;
}

async function sendShareMail(c: Context<AppEnv>, to: string, node: StorageNode, shareId: string) {
  const { config, user, log } = c.var;
  if (!config.SYSTEM_MAIL_FROM) {
    log.warn("storage.share_mail_skipped", { reason: "SYSTEM_MAIL_FROM is not set" });
    return;
  }
  const appName = config.auth.appName;
  const url = new URL(`/s/${shareId}`, config.auth.webAppURL);
  const name = mailName(node.name);
  await systemMailSender({ email: c.env.EMAIL, config, log })({
    to,
    subject: `${user.email} shared "${name}" with you on ${appName}`,
    text: [
      `${user.email} shared "${name}" with you on ${appName}.`,
      "",
      "Open this link to see it:",
      "",
      url.toString(),
      "",
      `Sign in with ${to} to open it. If you did not expect it, ignore this email.`,
    ].join("\n"),
  });
}

async function linkSettings(body: {
  expiresAt?: string | null;
  password?: string | null;
  downloads?: boolean;
  role?: StorageLinkSettings["role"];
}) {
  const settings: StorageLinkSettings = {};
  if (body.expiresAt !== undefined) {
    settings.expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);
  }
  if (body.password !== undefined) {
    settings.passwordHash = body.password === null ? null : await hashLinkPassword(body.password);
  }
  if (body.downloads !== undefined) settings.downloads = body.downloads;
  if (body.role !== undefined) settings.role = body.role;
  return settings;
}

const recheckOutside = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.req.method === "GET" || !c.res.ok) return;
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.var.member.orgId));
  c.executionCtx.waitUntil(
    stub
      .recheckOutsiders("all")
      .catch((error: unknown) => c.var.log.warn("storage.outside_recheck_failed", { error })),
  );
});

export const storageSharing = new Hono<AppEnv>()
  .use("/nodes/:id/sharing/*", recheckOutside)
  .use("/uploads/:id/sharing/*", recheckOutside)
  .use("/policy", recheckOutside)
  .get("/nodes/:id/sharing", async (c) => {
    const found = await memberStorage(c).sharing(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found.status);
    return answer(c, found.sharing);
  })

  .put("/nodes/:id/sharing/link", zValidator("json", storageSetLinkBodySchema), async (c) => {
    const body = c.req.valid("json");
    const files = memberStorage(c);
    const id = c.req.param("id");
    const changed =
      "reset" in body
        ? await files.resetLink(id)
        : "linkAccess" in body
          ? await files.setLinkAccess(id, body.linkAccess)
          : await files.setLinkSettings(id, await linkSettings(body));
    if (changed.status !== "ok") return refused(c, changed.status);
    return answer(c, changed.sharing);
  })

  .get("/uploads/:id/sharing", async (c) => {
    const found = await memberStorage(c).uploadSharing(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found.status);
    return answer(c, found.sharing);
  })

  .put("/uploads/:id/sharing/link", zValidator("json", storageSetLinkBodySchema), async (c) => {
    const body = c.req.valid("json");
    const files = memberStorage(c);
    const id = c.req.param("id");
    const changed =
      "reset" in body
        ? await files.resetUploadLink(id)
        : "linkAccess" in body
          ? await files.setUploadLinkAccess(id, body.linkAccess)
          : await files.setUploadLinkSettings(id, await linkSettings(body));
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
        const { env, var: vars } = c;
        const checks: Parameters<typeof longestWait>[0] = [
          ["storageShare", checkRateLimit(env, vars.config, "storageShare", vars.member.id)],
        ];
        if (await onProbation(c)) {
          checks.push([
            "storageShareNew",
            checkRateLimit(env, vars.config, "storageShareNew", vars.user.id),
          ]);
        }
        const wait = await longestWait(checks);
        if (wait) return tooManyRequests(c, wait.wait, wait.rule);
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

  .get("/policy", async (c) => {
    const found = await memberStorage(c).policy();
    if (found.status !== "ok") return refused(c, found.status);
    return c.json({ policy: found.policy } satisfies StoragePolicyResponse);
  })

  .put("/policy", zValidator("json", storageSetPolicyBodySchema), async (c) => {
    const changed = await memberStorage(c).setPolicy(c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed.status);
    return c.json({ policy: changed.policy } satisfies StoragePolicyResponse);
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
