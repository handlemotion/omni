import { createAuth, type Auth } from "@omni/auth";
import { createDb, enqueueAction, findSystemMailbox, schema, type Db } from "@omni/db";
import type { SendPayload } from "@omni/contracts";
import { and, asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { loadConfig, type Config } from "./env.ts";
import { pingMailService } from "./mail-service.ts";

export interface Member {
  /** `members.id`: what `forMember` and every mail table key on. */
  id: string;
  orgId: string;
  userId: string;
  role: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { config: Config; db: Db; auth: Auth; member: Member };
}

/**
 * Per-request config, database and Better Auth. A Worker may not reuse a socket across requests,
 * so each request opens its own small pool over Hyperdrive (which keeps the real connections
 * warm) and closes it after the response.
 */
export const requestScope = createMiddleware<AppEnv>(async (c, next) => {
  const config = loadConfig(c.env);
  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    onnotice: () => {},
  });
  c.set("config", config);
  c.set("db", db);
  c.set("auth", createAuth({ db, ...config.auth, sendMagicLink: magicLinkSender(c, db, config) }));
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** Resolves the session to a member of its active org (or the user's first org). 401 without one. */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: "sign in first" });

  const activeOrg = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  const [member] = await c.var.db
    .select({
      id: schema.members.id,
      orgId: schema.members.organizationId,
      userId: schema.members.userId,
      role: schema.members.role,
    })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, session.user.id),
        activeOrg ? eq(schema.members.organizationId, activeOrg) : undefined,
      ),
    )
    .orderBy(asc(schema.members.createdAt))
    .limit(1);
  if (!member) throw new HTTPException(403, { message: "not a member of any organization" });
  c.set("member", member);
  await next();
});

/**
 * Magic links go out as an ordinary `send` in the outbox, from the mailbox at
 * `SYSTEM_MAIL_FROM`, so they get the mail service's retries and idempotency for free.
 */
function magicLinkSender(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  db: Db,
  config: Config,
) {
  return async ({ email, url }: { email: string; url: string }) => {
    if (!config.SYSTEM_MAIL_FROM) {
      throw new Error("SYSTEM_MAIL_FROM is not set: magic links have no mailbox to send from");
    }
    const mailbox = await findSystemMailbox(db, config.SYSTEM_MAIL_FROM);
    if (!mailbox) {
      throw new Error("SYSTEM_MAIL_FROM does not match any mailbox in the database");
    }
    const appName = config.auth.appName;
    await enqueueAction(db, {
      orgId: mailbox.orgId,
      mailboxId: mailbox.id,
      memberId: null,
      kind: "send",
      idempotencyKey: `magic-link:${await sha256Hex(url)}`,
      payload: {
        from: mailbox.address,
        to: [email],
        subject: `Sign in to ${appName}`,
        text: `Open this link to sign in to ${appName}:\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
      } satisfies SendPayload,
    });
    c.executionCtx.waitUntil(pingMailService(config));
  };
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
