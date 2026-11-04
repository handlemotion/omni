import * as Sentry from "@sentry/cloudflare";
import { REQUEST_ID_HEADER as SIGNED_REQUEST_ID_HEADER } from "@omni/crypto";
import { forUser, orgSetupStep } from "@omni/db";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { findMember, requestScope, requireMember, type AppEnv } from "./context.ts";
import type { Config } from "./env.ts";
import { createLogger, REQUEST_ID_HEADER, requestIdFrom } from "./log.ts";
import { MEMBER_HEADER } from "./realtime.ts";
import { internal } from "./routes/internal.ts";
import { assets } from "./routes/assets.ts";
import { mail } from "./routes/mail.ts";
import { mailboxMembers } from "./routes/mailbox-members.ts";
import { onboarding } from "./routes/onboarding.ts";
import { account, pictures, workspaceLogo } from "./routes/pictures.ts";
import { workspaces } from "./routes/workspaces.ts";
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

/**
 * Thread routes (mail and assets) act as the user's member in the thread's org (ADR 0014), so a
 * thread opened from the cross-workspace list reads and changes as that member without
 * switching the active org. A thread none of their members can see keeps the active member, and
 * the route answers 404 as before.
 */
const actAsThreadMember = createMiddleware<AppEnv>(async (c, next) => {
  const threadId = c.req.param("id");
  const member = threadId && (await forUser(c.var.db, c.var.user.id).memberFor(threadId));
  if (member) c.set("member", member);
  await next();
});

const api = new Hono<AppEnv>()
  .use(requireMember)
  .use("/threads/:id/*", actAsThreadMember)
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
        ? await findMember(c.var.db, c.var.user.id, org)
        : c.var.member;
    if (!member) return c.json({ error: "not a member of that organization" }, 404);
    const { id, orgId } = member;
    const headers = new Headers(c.req.raw.headers);
    headers.set(MEMBER_HEADER, id);
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })
  .route("/", mail)
  .route("/", mailboxMembers)
  .route("/workspace", workspaceLogo)
  .route("/", assets);

export const app = new Hono<AppEnv>()
  .use(trace)
  .use(securityHeaders)
  .get("/health", (c) => c.json({ ok: true }))
  .route("/", internal)
  .use("/api/*", requestScope)
  /** Public: which sign-in buttons the login page shows. Google needs its OAuth client set. */
  .get("/api/sign-in-methods", (c) => c.json({ google: c.var.config.auth.google !== undefined }))
  .on(["GET", "POST"], "/api/auth/*", limitAuth, (c) => c.var.auth.handler(c.req.raw))
  // Before `api`: these work for a user who has no organization yet.
  .route("/api/onboarding", onboarding)
  .route("/api/workspaces", workspaces)
  .route("/api/account", account)
  .route("/api/pictures", pictures)
  .route("/api", api)
  .onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    // Hono catches it before `withSentry` could, so the logger reports it.
    (c.var.log ?? createLogger()).error("http.error", { error, orgId: c.var.member?.orgId });
    return c.json({ error: "internal error", requestId: c.var.requestId }, 500);
  });

/** Hono RPC type for web and iOS: `hc<AppType>(baseUrl)`. */
export type AppType = typeof app;
