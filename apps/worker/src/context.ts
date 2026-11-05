import { createAuth, type Auth, type InvitationMessage } from "@omni/auth";
import { schema, type Db } from "@omni/db";
import { and, asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { openDb } from "./db.ts";
import { loadConfig, type Config } from "./env.ts";
import type { Logger } from "./log.ts";

export interface Member {
  /** `members.id`: what `forMember` and every mail table key on. */
  id: string;
  orgId: string;
  userId: string;
  role: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    config: Config;
    db: Db;
    auth: Auth;
    member: Member;
    user: SessionUser;
    /** This request's ID (`x-request-id`), on every log line, outbox row and mail-service call. */
    requestId: string;
    log: Logger;
  };
}

/** Per-request config, database (`openDb`) and Better Auth, closed after the response. */
export const requestScope = createMiddleware<AppEnv>(async (c, next) => {
  const config = loadConfig(c.env);
  const { db, close } = openDb(c.env, 5);
  c.set("config", config);
  c.set("db", db);
  const mail = systemMailSender({ email: c.env.EMAIL, config, log: c.var.log });
  c.set(
    "auth",
    createAuth({
      db,
      ...config.auth,
      billingLog: (event, fields) => c.var.log.error(event, fields),
      sendMagicLink: async ({ email, url }) => {
        devLog(config, { kind: "magic-link", email, url });
        const appName = config.auth.appName;
        await mail({
          to: email,
          subject: `Sign in to ${appName}`,
          text: `Open this link to sign in to ${appName}:\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
        });
      },
      sendInvitation: async (invite) => {
        devLog(config, { kind: "invitation", email: invite.email, url: invite.url });
        await mail({
          to: invite.email,
          subject: `${invite.inviterName} invited you to ${invite.organizationName} on ${config.auth.appName}`,
          text: invitationText(invite, config.auth.appName),
        });
      },
    }),
  );
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** The signed-in user, from Better Auth's session. */
export interface SessionUser {
  id: string;
  email: string;
}

/**
 * The session's user and their member in the active org (or the user's first org), or null when
 * signed out. `member` is null for a user who belongs to no organization yet.
 */
export async function resolveSession(c: {
  req: { raw: Request };
  var: { auth: Auth; db: Db };
}): Promise<{ user: SessionUser; member: Member | null } | null> {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const activeOrg = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  const member = await findMember(c.var.db, session.user.id, activeOrg ?? undefined);
  return { user: { id: session.user.id, email: session.user.email }, member };
}

/** `userId`'s member in `orgId` (without one, their oldest membership), or null. */
export async function findMember(db: Db, userId: string, orgId?: string): Promise<Member | null> {
  const [member] = await db
    .select({
      id: schema.members.id,
      orgId: schema.members.organizationId,
      userId: schema.members.userId,
      role: schema.members.role,
    })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        orgId ? eq(schema.members.organizationId, orgId) : undefined,
      ),
    )
    .orderBy(asc(schema.members.createdAt))
    .limit(1);
  return member ?? null;
}

/** Resolves the session to a member of its active org (or the user's first org). 401 without one. */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  if (!resolved.member)
    throw new HTTPException(403, { message: "not a member of any organization" });
  c.set("user", resolved.user);
  c.set("member", resolved.member);
  await next();
});

/**
 * Auth and notice mail (magic links, invitations, domain notices) goes out through Cloudflare Email
 * Sending (the `EMAIL` binding), from `SYSTEM_MAIL_FROM` under the app's name. It does not use a
 * mailbox, so a new install can sign people in before it has any.
 */
export function systemMailSender(scope: { email: SendEmail; config: Config; log: Logger }) {
  return async (message: { to: string; subject: string; text: string }) => {
    const from = scope.config.SYSTEM_MAIL_FROM;
    if (!from) throw new Error("SYSTEM_MAIL_FROM is not set: there is no address to send from");
    try {
      await scope.email.send({
        from: { email: from, name: scope.config.auth.appName },
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (error) {
      // The code says why (for example E_SENDER_NOT_VERIFIED); never the message's link.
      scope.log.error("system_mail.failed", { code: (error as { code?: string }).code, error });
      throw error;
    }
  };
}

function invitationText(invite: InvitationMessage, appName: string) {
  return [
    `${invite.inviterName} invited you to join ${invite.organizationName} on ${appName}.`,
    "",
    `Open this link to accept:`,
    "",
    invite.url,
    "",
    `It expires on ${invite.expiresAt.toUTCString()}. If you did not expect it, ignore this email.`,
  ].join("\n");
}

/**
 * Local sign-in without digging the link out of GreenMail. Only under ENVIRONMENT=development:
 * these URLs are bearer credentials, so production and test never log them.
 */
function devLog(config: Config, link: { kind: string; email: string; url: string }) {
  if (config.ENVIRONMENT !== "development") return;
  console.log(JSON.stringify({ event: "auth.dev_link", ...link }));
}
