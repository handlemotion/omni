import {
  createAuth,
  usesOAuthProvider,
  type Auth,
  type InvitationMessage,
  type ModuleLifecycle,
} from "@omni/auth";
import { WORKSPACE_HEADER, WORKSPACE_PARAM } from "@omni/contracts/headers";
import {
  ensurePersonalSpace,
  forUser,
  isCompany,
  schema,
  sessionAccess,
  talkRole,
  type Db,
  type OpenUploadLinkResult,
  type SharedAccess,
} from "@omni/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { openDb } from "./db.ts";
import { loadConfig, type Config } from "./env.ts";
import type { Logger } from "./log.ts";
import { modules } from "./modules.ts";

export interface Member {
  /** `members.id`: what `forMember` and every mail table key on. */
  id: string;
  orgId: string;
  userId: string;
  role: string;
}

/** Who a sync token acts for. */
export interface SyncCaller {
  userId: string;
  clientId: string;
  /** The one workspace the grant reaches, or null for every workspace the person is in. */
  workspace: string | null;
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
    /** Set under `/api/storage/shared/:shareId` only: Storage reached by a grant or a link. */
    shared?: SharedAccess;
    /** Set beside `shared`: the signed-in person who opened it, or null for a visitor. */
    linkUser?: SessionUser | null;
    /** Set instead of `shared` when the link was made for a file that is still uploading. */
    uploadingLink?: Extract<OpenUploadLinkResult, { status: "open" }>;
    /** Set under `/api/storage/sync` only: who a desktop sync token acts for. */
    syncCaller?: SyncCaller;
  };
}

const leavesRealtime = (env: Env) =>
  ({
    name: "realtime",
    memberRemoved: (_db, { orgId, memberId }) =>
      env.REALTIME.get(env.REALTIME.idFromName(orgId)).disconnect(memberId),
    memberRoleChanged: async (_db, { orgId, memberId, role, previousRole }) => {
      if (talkRole(role) === talkRole(previousRole)) return;
      await env.REALTIME.get(env.REALTIME.idFromName(orgId)).disconnect(memberId);
    },
  }) satisfies ModuleLifecycle;

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
      modules: [...modules, leavesRealtime(c.env)],
      oauthProvider: usesOAuthProvider(new URL(c.req.url).pathname),
      sendMagicLink: async ({ email, signInAs, url }) => {
        devLog(config, { kind: "magic-link", email, url });
        const appName = config.auth.appName;
        const as = signInAs.toLowerCase() === email ? "" : ` as ${signInAs}`;
        await mail({
          to: email,
          subject: `Sign in to ${appName}${as}`,
          text: `Open this link to sign in to ${appName}${as}:\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
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
  /**
   * The one organization this session reaches when it was opened with a company's address,
   * or null when it reaches every workspace the user belongs to.
   */
  scopeOrgId: string | null;
}

/**
 * The session's user and their member, or null when signed out. `member` is null for a user who
 * belongs to no organization yet. With `threadId` (thread routes) it is the user's member
 * in that thread's org when one of their members can see it, so a thread opened from the
 * cross-workspace list reads and changes as that member without switching the active org;
 * otherwise, and without `threadId`, it is the member in the workspace the request names
 * (`omni-workspace`), else in the session's active org (or the user's first org).
 * Both lookups run in one round trip.
 */
export const resolveSession: (
  c: {
    req: { raw: Request };
    var: { auth: Auth; db: Db };
    header: (name: string, value: string, options?: { append?: boolean }) => void;
  },
  threadId?: string,
) => Promise<{ user: SessionUser; member: Member | null } | null> = async (c, threadId) => {
  const { headers, response: session } = await c.var.auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
  if (!session) return null;
  const activeOrg =
    c.req.raw.headers.get(WORKSPACE_HEADER) ||
    new URL(c.req.raw.url).searchParams.get(WORKSPACE_PARAM) ||
    (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  const access = await sessionAccess(c.var.db, session.session.id);
  if (!access) return null;
  const { scopeOrgId } = access;
  const [active, ofThread] = await Promise.all([
    findMember(c.var.db, session.user.id, activeOrg ?? undefined, scopeOrgId),
    threadId ? forUser(c.var.db, session.user.id, scopeOrgId).memberFor(threadId) : null,
  ]);
  return {
    user: { id: session.user.id, email: session.user.email, scopeOrgId },
    member: ofThread ?? active,
  };
};

/**
 * `userId`'s member in `orgId`, or null. Without `orgId`, their oldest company membership, or their
 * Personal space when they are in no company (null when they have neither). A session scoped to a company
 * (`scopeOrgId`) finds only its member there, whatever `orgId` asks for.
 */
export const findMember: (
  db: Db,
  userId: string,
  orgId?: string,
  scopeOrgId?: string | null,
) => Promise<Member | null> = async (db, userId, orgId, scopeOrgId) => {
  if (scopeOrgId && orgId && orgId !== scopeOrgId) return null;
  if (scopeOrgId) orgId = scopeOrgId;
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
    .orderBy(
      sql`case when ${isCompany(db, schema.members.organizationId)} then 0 else 1 end`,
      asc(schema.members.createdAt),
    )
    .limit(1);
  return member ?? null;
};

/**
 * Every member the session may act as: the user's member in each workspace they belong to, or
 * only the one in the company the session is scoped to.
 */
export async function findMemberIds(db: Db, userId: string, scopeOrgId?: string | null) {
  const rows = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        scopeOrgId ? eq(schema.members.organizationId, scopeOrgId) : undefined,
      ),
    )
    .orderBy(asc(schema.members.createdAt));
  return rows.map((row) => row.id);
}

function memberMiddleware(threadParam?: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("member")) return next();
    const resolved = await resolveSession(c, threadParam ? c.req.param(threadParam) : undefined);
    if (!resolved) throw new HTTPException(401, { message: "sign in first" });
    if (!resolved.member)
      throw new HTTPException(403, { message: "not a member of any organization" });
    c.set("user", resolved.user);
    c.set("member", resolved.member);
    c.header(WORKSPACE_HEADER, resolved.member.orgId);
    await next();
  });
}

/**
 * Expand step for clients from before Personal spaces were made on demand: one that does not send
 * `personal=on-demand` reads `/api/me` and `/api/workspaces` expecting every signed-in person to
 * be in a workspace (the web app's guard sent them to sign in again; iOS waited forever), so
 * someone in none gets their Personal space here, as sign-in used to make it. Remove once those
 * clients are gone.
 */
export const personalSpaceForOldClients = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.query("personal") !== "on-demand") {
    const resolved = await resolveSession(c);
    if (resolved && !resolved.member && !resolved.user.scopeOrgId) {
      await ensurePersonalSpace(c.var.db, resolved.user.id);
    }
  }
  await next();
});

/** Resolves the session to a member of its active org (or the user's first org). 401 without one. */
export const requireMember = memberMiddleware();

/**
 * `requireMember` for `/threads/:id/*`: the user's member who can see thread `:id`,
 * else the active member, and the route answers 404 for a thread none of them can see.
 */
export const requireThreadMember = memberMiddleware("id");

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

function devLog(config: Config, link: { kind: string; email: string; url: string }) {
  if (config.ENVIRONMENT !== "development") return;
  console.log(JSON.stringify({ event: "auth.dev_link", ...link }));
}

async function requestedMailbox(c: {
  req: {
    query(name: string): string | undefined;
    method: string;
    header(name: string): string | undefined;
    json(): Promise<unknown>;
  };
}) {
  const fromQuery = c.req.query("mailboxId");
  if (fromQuery) return fromQuery;
  if (c.req.method === "GET" || !c.req.header("content-type")?.includes("application/json")) {
    return undefined;
  }
  const body = (await c.req.json().catch(() => null)) as { mailboxId?: unknown } | null;
  return typeof body?.mailboxId === "string" ? body.mailboxId : undefined;
}

/**
 * A request that names a mailbox runs as the user's member who can open it, in its own
 * workspace (write from any address you can open), as thread routes do.
 * Only mailboxes `forUser` shows count, so a scoped session stays in its company. One it cannot
 * see leaves the active member in place, and the route answers as before.
 */
export const requireMailboxMember = createMiddleware<AppEnv>(async (c, next) => {
  const reader = forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId);
  const resource = /^\/api\/(drafts|actions)\/([^/]+)/.exec(c.req.path);
  const mailboxId = resource ? undefined : await requestedMailbox(c);
  const member = resource
    ? await reader.memberForResource(resource[1] === "drafts" ? "draft" : "action", resource[2]!)
    : mailboxId
      ? await reader.memberForMailbox(mailboxId)
      : null;
  if (member && member.id !== c.var.member.id) c.set("member", member);
  await next();
});
