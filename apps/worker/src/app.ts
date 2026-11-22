import * as Sentry from "@sentry/cloudflare";
import { areaOf } from "@omni/mail-core/telemetry";
import { withSignInRequest } from "@omni/auth";
import { REQUEST_ID_HEADER as SIGNED_REQUEST_ID_HEADER } from "@omni/crypto";
import { orgSetupStep, schema, talkRole } from "@omni/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import {
  findMember,
  personalSpaceForOldClients,
  requestScope,
  requireMailboxMember,
  requireMember,
  requireThreadMember,
  resolveSession,
  type AppEnv,
} from "./context.ts";
import type { Config } from "./env.ts";
import { portal } from "./crm/portal.ts";
import { calendar } from "./calendar/routes.ts";
import { crm } from "./crm/routes.ts";
import { talk } from "./talk/routes.ts";
import { meetings } from "./meetings/routes.ts";
import { answerThrown, apiError } from "./errors.ts";
import { createLogger, REQUEST_ID_HEADER, requestIdFrom } from "./log.ts";
import { MEMBER_HEADER, WATCH_HEADER } from "./realtime.ts";
import { OUTSIDE_HEADER } from "./realtime-outside.ts";
import { TEAM_HEADER } from "./realtime-talk.ts";
import { account } from "./routes/account.ts";
import { internal } from "./routes/internal.ts";
import { assets } from "./routes/assets.ts";
import { billing } from "./routes/billing.ts";
import { billingCards } from "./routes/billing-cards.ts";
import { conversations } from "./routes/conversations.ts";
import { stripeWebhook } from "./routes/stripe-webhook.ts";
import { compose } from "./routes/compose.ts";
import { unsubscribe } from "./routes/unsubscribe.ts";
import { handoff } from "./routes/handoff.ts";
import { connect, desktopGoogleReturn } from "./routes/connect.ts";
import { desktop } from "./routes/desktop.ts";
import { folders } from "./routes/folders.ts";
import { library } from "./routes/library.ts";
import { mail } from "./routes/mail.ts";
import { saveToDrive } from "./mail/save-to-drive.ts";
import { forwarding } from "./routes/forwarding.ts";
import { mailCrmSharing } from "./mail/crm-sharing.ts";
import { workspaceAdmin } from "./routes/workspace-admin.ts";
import { aiSettings } from "./routes/ai-settings.ts";
import { workspaceInboxes } from "./routes/workspace-inboxes.ts";
import { workspaceInvitations } from "./routes/workspace-invitations.ts";
import { invitations } from "./routes/invitations.ts";
import { onboarding } from "./routes/onboarding.ts";
import { account as accountPicture, pictures, workspaceLogo } from "./routes/pictures.ts";
import { storage } from "./storage/routes.ts";
import { storageShared } from "./storage/shared.ts";
import { storageSigning } from "./storage/signing.ts";
import { storageSync } from "./storage/sync.ts";
import { workspaces } from "./routes/workspaces.ts";
import { join } from "./routes/join.ts";
import { appLinks } from "./routes/app-links.ts";
import { mcp } from "./routes/mcp.ts";
import { oauth } from "./routes/oauth.ts";
import { limitAuth } from "./rate-limiter.ts";
import { securityHeaders } from "./security-headers.ts";

function allowedOrigins(config: Config) {
  return new Set([new URL(config.auth.baseURL).origin, ...config.auth.trustedOrigins]);
}

function tokenRequestWithoutSessionCookies(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
}

const trace = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = requestIdFrom(
    c.req.header(REQUEST_ID_HEADER) ?? c.req.header(SIGNED_REQUEST_ID_HEADER),
  );
  const log = createLogger({ component: "api", requestId });
  c.set("requestId", requestId);
  c.set("log", log);
  Sentry.setTag("request_id", requestId);
  Sentry.setTag("area", areaOf(c.req.path));
  const started = Date.now();
  try {
    await next();
  } finally {
    try {
      c.res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {}
    log.info("http.request", {
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      durationMs: Date.now() - started,
      orgId: c.var.member?.orgId,
    });
  }
});

const api = new Hono<AppEnv>()
  .use("/threads/:id/*", requireThreadMember)
  .use("/me", personalSpaceForOldClients)
  .use(requireMember)
  .use(requireMailboxMember)
  .get("/me", async (c) =>
    c.json({ ...c.var.member, setup: await orgSetupStep(c.var.db, c.var.member.orgId) }),
  )
  .get("/realtime", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return apiError(c, "upgrade_required", "expected a websocket upgrade");
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins(c.var.config).has(origin)) {
      return apiError(c, "forbidden", "origin not allowed");
    }
    const org = c.req.query("org");
    const member =
      org && org !== c.var.member.orgId
        ? await findMember(c.var.db, c.var.user.id, org, c.var.user.scopeOrgId)
        : c.var.member;
    if (!member) return apiError(c, "not_found", "not a member of that organization");
    const { id, orgId } = member;
    const headers = new Headers(c.req.raw.headers);
    headers.delete(OUTSIDE_HEADER);
    headers.set(MEMBER_HEADER, id);
    headers.delete(TEAM_HEADER);
    if (c.req.query("watch") === "1") headers.set(WATCH_HEADER, "1");
    else {
      headers.delete(WATCH_HEADER);
      if (c.req.query("talk") === "1" && talkRole(member.role)) headers.set(TEAM_HEADER, "1");
    }
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })
  .route("/", mail)
  .route("/", saveToDrive)
  .route("/", forwarding)
  .route("/mail", mailCrmSharing)
  .route("/", compose)
  .route("/", unsubscribe)
  .route("/", handoff)
  .route("/", folders)
  .route("/connect", connect)
  .route("/", library)
  .route("/", conversations)
  .route("/", workspaceAdmin)
  .route("/", aiSettings)
  .route("/", workspaceInboxes)
  .route("/", workspaceInvitations)
  .route("/workspace", workspaceLogo)
  .route("/", assets)
  .route("/", billing)
  .route("/", billingCards)
  .route("/storage", storage)
  .route("/crm", crm)
  .route("/calendar", calendar)
  .route("/talk", talk)
  .route("/meetings", meetings);

async function isPendingResend(c: Context<AppEnv>) {
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => null)) as { email?: unknown; resend?: unknown; organizationId?: unknown } | null;
  if (body?.resend !== true || typeof body.email !== "string") return false;
  const orgId = (await resolveSession(c))?.member?.orgId;
  if (!orgId || (body.organizationId !== undefined && body.organizationId !== orgId)) return false;
  const [pending] = await c.var.db
    .select({ id: schema.invitations.id })
    .from(schema.invitations)
    .where(
      and(
        eq(schema.invitations.organizationId, orgId),
        eq(schema.invitations.status, "pending"),
        eq(sql`lower(${schema.invitations.email})`, body.email.toLowerCase()),
      ),
    );
  return pending !== undefined;
}

export const app = new Hono<AppEnv>()
  .use(trace)
  .use(securityHeaders)
  .get("/health", (c) => c.json({ ok: true }))
  .route("/desktop", desktop)
  .route("/", internal)
  .use("/api/*", requestScope)
  .use("/mcp", requestScope)
  .use("/.well-known/*", requestScope)
  .route("/", appLinks)
  .route("/", mcp)
  .get("/api/sign-in-methods", (c) => c.json({ google: c.var.config.auth.google !== undefined }))
  .route("/api/auth/stripe/webhook", stripeWebhook)
  .post("/api/auth/subscription/*", (c) => apiError(c, "not_found", "use /api/billing"))
  .post("/api/auth/organization/invite-member", limitAuth, async (c) => {
    if (await isPendingResend(c)) return withSignInRequest(() => c.var.auth.handler(c.req.raw));
    return apiError(c, "not_found", "use /api/workspace/invitations");
  })
  .post("/api/auth/oauth2/token", limitAuth, (c) =>
    withSignInRequest(() => c.var.auth.handler(tokenRequestWithoutSessionCookies(c.req.raw))),
  )
  .on(["GET", "POST"], "/api/auth/*", limitAuth, (c) =>
    withSignInRequest(() => c.var.auth.handler(c.req.raw)),
  )
  .route("/api/onboarding", onboarding)
  .route("/api/workspaces", workspaces)
  .route("/api/join", join)
  .route("/api/invitations", invitations)
  .route("/api/oauth", oauth)
  .route("/api/account", account)
  .route("/api/account", accountPicture)
  .route("/api/pictures", pictures)
  .route("/api/storage/shared", storageShared)
  .route("/api/storage/signing", storageSigning)
  .route("/api/portal", portal)
  .route("/api/storage/sync", storageSync)
  .use("/api/connect/google/callback", desktopGoogleReturn)
  .route("/api", api)
  .onError(answerThrown);

/** Hono RPC type for web and iOS: `hc<AppType>(baseUrl)`. */
export type AppType = typeof app;
