import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestScope, requireMember, type AppEnv } from "./context.ts";
import { MEMBER_HEADER } from "./realtime.ts";
import { internal } from "./routes/internal.ts";
import { mail } from "./routes/mail.ts";

const api = new Hono<AppEnv>()
  .use(requireMember)
  .get("/me", (c) => c.json(c.var.member))
  /** Websocket of `{ type: "changed", mailboxId, threadIds }` events for this member. */
  .get("/realtime", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.json({ error: "expected a websocket upgrade" }, 426);
    }
    const { id, orgId } = c.var.member;
    const headers = new Headers(c.req.raw.headers);
    headers.set(MEMBER_HEADER, id);
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })
  .route("/", mail);

export const app = new Hono<AppEnv>()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/", internal)
  .use("/api/*", requestScope)
  .on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw))
  .route("/api", api)
  .onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  });

/** Hono RPC type for web and iOS: `hc<AppType>(baseUrl)`. */
export type AppType = typeof app;
