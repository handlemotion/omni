import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestScope, requireMember, type AppEnv } from "./context.ts";
import { internal } from "./routes/internal.ts";
import { mail } from "./routes/mail.ts";

const api = new Hono<AppEnv>()
  .use(requireMember)
  .get("/me", (c) => c.json(c.var.member))
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
