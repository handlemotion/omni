import * as Sentry from "@sentry/cloudflare";
import { withSignInRequest } from "@omni/auth";
import { REQUEST_ID_HEADER as SIGNED_REQUEST_ID_HEADER } from "@omni/crypto";
import { orgSetupStep, schema } from "@omni/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { requireWritableWorkspace } from "./billing.ts";
import {
  findMember,
  requestScope,
  requireMailboxMember,
  requireMember,
  requireThreadMember,
  resolveSession,
  type AppEnv,
} from "./context.ts";
import type { Config } from "./env.ts";
import { createLogger, REQUEST_ID_HEADER, requestIdFrom } from "./log.ts";
import { MEMBER_HEADER } from "./realtime.ts";
import { account } from "./routes/account.ts";
import { internal } from "./routes/internal.ts";
import { assets } from "./routes/assets.ts";
import { billing } from "./routes/billing.ts";
import { billingCards } from "./routes/billing-cards.ts";
import { conversations } from "./routes/conversations.ts";
import { stripeWebhook } from "./routes/stripe-webhook.ts";
import { compose } from "./routes/compose.ts";
import { connect } from "./routes/connect.ts";
import { folders } from "./routes/folders.ts";
import { library } from "./routes/library.ts";
import { mail } from "./routes/mail.ts";
import { workspaceAdmin } from "./routes/workspace-admin.ts";
import { workspaceInboxes } from "./routes/workspace-inboxes.ts";
import { workspaceInvitations } from "./routes/workspace-invitations.ts";
import { onboarding } from "./routes/onboarding.ts";
import { account as accountPicture, pictures, workspaceLogo } from "./routes/pictures.ts";
import { workspaces } from "./routes/workspaces.ts";
import { join } from "./routes/join.ts";
import { mcp } from "./routes/mcp.ts";
import { oauth } from "./routes/oauth.ts";
import { limitAuth } from "./rate-limiter.ts";
import { securityHeaders } from "./security-headers.ts";

function allowedOrigins(config: Config) {
  return new Set([new URL(config.auth.baseURL).origin, ...config.auth.trustedOrigins]);
}

/**
 * One ID per request: the caller's `x-request-id` (web, iOS) or the mail service's signed one
 * when well-formed, else a fresh one. Echoed on the response; on every log line, outbox row,
 * mail-service call and Sentry event of this request. Logs the route pattern, never the URL:
 * query strings carry search terms.
 */
const trace = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = requestIdFrom(
    c.req.header(REQUEST_ID_HEADER) ?? c.req.header(SIGNED_REQUEST_ID_HEADER),
  );
  const log = createLogger({ component: "api", requestId });
  c.set("requestId", requestId);
  c.set("log", log);
  Sentry.setTag("request_id", requestId);
  const started = Date.now();
  try {
    await next();
  } finally {
    try {
      c.res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      // Immutable headers (a Durable Object's websocket upgrade): the log still has it.
    }
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
  // Thread routes (mail and assets) act as the user's member in the thread's org (ADR 0014).
  .use("/threads/:id/*", requireThreadMember)
  .use(requireMember)
  // A request naming a mailbox acts as the user's member who can open it (ADR 0024).
  .use(requireMailboxMember)
  // Deny by default: every write below needs a plan in good standing unless `READ_ONLY_ALLOWED`
  // (billing.ts) names it. After `requireThreadMember`, so a thread write checks the thread's org.
  .use(requireWritableWorkspace)
  /** The member in the active org, with how far that org's setup got (route guards read it). */
  .get("/me", async (c) =>
    c.json({ ...c.var.member, setup: await orgSetupStep(c.var.db, c.var.member.orgId) }),
  )
  /**
   * Websocket of `{ type: "changed", mailboxId, threadIds }` events for this member, or with
   * `?org=<id>` for the user's member in that org (the cross-workspace view keeps one per org).
   */
  .get("/realtime", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.json({ error: "expected a websocket upgrade" }, 426);
    }
    // The socket authenticates by cookie, and browsers send cookies on cross-site websocket
    // handshakes, so a foreign page could open one as the member (cross-site WebSocket
    // hijacking). Browsers always send Origin on a handshake: accept only our own origins. A
    // handshake with no Origin comes from a native client, which has to hold the session itself.
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins(c.var.config).has(origin)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    const org = c.req.query("org");
    const member =
      org && org !== c.var.member.orgId
        ? await findMember(c.var.db, c.var.user.id, org, c.var.user.scopeOrgId)
        : c.var.member;
    if (!member) return c.json({ error: "not a member of that organization" }, 404);
    const { id, orgId } = member;
    const headers = new Headers(c.req.raw.headers);
    headers.set(MEMBER_HEADER, id);
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })
  .route("/", mail)
  .route("/", compose)
  .route("/", folders)
  .route("/connect", connect)
  .route("/", library)
  .route("/", conversations)
  .route("/", workspaceAdmin)
  .route("/", workspaceInboxes)
  .route("/", workspaceInvitations)
  .route("/workspace", workspaceLogo)
  .route("/", assets)
  .route("/", billing)
  .route("/", billingCards);

/** A resend, from the old web app, of an invitation already pending in the session's workspace. */
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
  .route("/", internal)
  .use("/api/*", requestScope)
  // People's own agents (ADR 0029): the MCP endpoint and its OAuth discovery documents.
  .use("/mcp", requestScope)
  .use("/.well-known/*", requestScope)
  .route("/", mcp)
  /** Public: which sign-in buttons the login page shows. Google needs its OAuth client set. */
  .get("/api/sign-in-methods", (c) => c.json({ google: c.var.config.auth.google !== undefined }))
  // Stripe calls this, not a browser: no per-IP auth limit. It dedupes and orders events, then
  // hands them to Better Auth's Stripe plugin.
  .route("/api/auth/stripe/webhook", stripeWebhook)
  // Checkout and the portal go through /api/billing, which pins them to the active workspace.
  // The plugin's own POSTs would also let a person subscribe for themselves, so they are closed.
  .post("/api/auth/subscription/*", (c) => c.json({ error: "use /api/billing" }, 404))
  // Invitations carry the new member's inbox, so they go through the Worker (ADR 0026). Tabs
  // loaded before that still resend here: a resend of an invitation already pending in the
  // session's workspace passes; anything else would skip the inbox rule. Remove once those tabs
  // have reloaded.
  .post("/api/auth/organization/invite-member", limitAuth, async (c) => {
    if (await isPendingResend(c)) return withSignInRequest(() => c.var.auth.handler(c.req.raw));
    return c.json({ error: "use /api/workspace/invitations" }, 404);
  })
  .on(["GET", "POST"], "/api/auth/*", limitAuth, (c) =>
    // Each auth request records the address it signs in with, to scope its session (ADR 0024).
    withSignInRequest(() => c.var.auth.handler(c.req.raw)),
  )
  // Before `api`: these work for a user who has no organization yet.
  .route("/api/onboarding", onboarding)
  .route("/api/workspaces", workspaces)
  .route("/api/join", join)
  // An agent's sign-in: back to the request after login, and the consent screen's workspace.
  .route("/api/oauth", oauth)
  .route("/api/account", account)
  // Your picture lives beside your sign-in emails under /api/account.
  .route("/api/account", accountPicture)
  .route("/api/pictures", pictures)
  .route("/api", api)
  .onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message, requestId: c.var.requestId }, error.status);
    }
    // Hono catches it before `withSentry` could, so the logger reports it.
    (c.var.log ?? createLogger()).error("http.error", { error, orgId: c.var.member?.orgId });
    return c.json({ error: "internal error", requestId: c.var.requestId }, 500);
  });

/** Hono RPC type for web and iOS: `hc<AppType>(baseUrl)`. */
export type AppType = typeof app;
