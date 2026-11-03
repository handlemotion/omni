import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestScope, requireMember, type AppEnv } from "./context.ts";
import type { Config } from "./env.ts";
import { MEMBER_HEADER } from "./realtime.ts";
import { internal } from "./routes/internal.ts";
import { assets } from "./routes/assets.ts";
import { mail } from "./routes/mail.ts";
import { mailboxMembers } from "./routes/mailbox-members.ts";

function allowedOrigins(config: Config) {
  return new Set([new URL(config.auth.baseURL).origin, ...config.auth.trustedOrigins]);
}

const api = new Hono<AppEnv>()
  .use(requireMember)
  .get("/me", (c) => c.json(c.var.member))
  /** Websocket of `{ type: "changed", mailboxId, threadIds }` events for this member. */
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
    const { id, orgId } = c.var.member;
    const headers = new Headers(c.req.raw.headers);
    headers.set(MEMBER_HEADER, id);
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })
  .route("/", mail)
  .route("/", mailboxMembers)
  .route("/", assets);

export const app = new Hono<AppEnv>()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/", internal)
  .use("/api/*", requestScope)
  /** Public: which sign-in buttons the login page shows. Google needs its OAuth client set. */
  .get("/api/sign-in-methods", (c) => c.json({ google: c.var.config.auth.google !== undefined }))
  .on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw))
  .route("/api", api)
  .onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  });

/** Hono RPC type for web and iOS: `hc<AppType>(baseUrl)`. */
export type AppType = typeof app;
