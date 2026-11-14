// The MCP endpoint and its OAuth discovery (ADR 0029). `/mcp` serves MCP 2026-07-28 and, on the
// same endpoint, 2025-era clients (still how Claude and ChatGPT connect), statelessly: no
// sessions, no streams, one JSON answer per request. Discovery documents come from Better Auth.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { authenticate, insufficientScope } from "../mcp/auth.ts";
import { checkRateLimit, type RateLimitRule } from "../rate-limiter.ts";
import { createServer, TOOL_SCOPES } from "../mcp/server.ts";

/** Browsers may call from our own origins only; native clients send no `Origin`. */
function originAllowed(origin: string | undefined, allowed: string[]) {
  return origin === undefined || allowed.includes(origin);
}

/** The scope a `tools/call` body needs beyond `mail:read`, if any. */
function toolScope(body: unknown) {
  if (typeof body !== "object" || body === null) return undefined;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  if (method !== "tools/call" || typeof params?.name !== "string") return undefined;
  return TOOL_SCOPES[params.name];
}

export const mcp = new Hono<AppEnv>()
  .post("/mcp", async (c) => {
    const { config, auth, db, log } = c.var;
    const baseURL = config.auth.baseURL;
    const allowed = [new URL(baseURL).origin, ...config.auth.trustedOrigins];
    if (!originAllowed(c.req.header("origin"), allowed)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    const caller = await authenticate(c.req.raw, auth, baseURL);
    if (caller instanceof Response) return caller;
    // A writing tool needs its own scope: answer 403 before it runs, so the client can step up.
    const needed = toolScope(
      await c.req.raw
        .clone()
        .json()
        .catch(() => null),
    );
    if (needed && !caller.scopes.has(needed)) return insufficientScope(baseURL, [needed]);
    c.set("log", log.child({ component: "mcp", clientId: caller.clientId }));

    const context = {
      env: c.env,
      db,
      requestId: c.var.requestId,
      waitUntil: (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise),
      caller,
      config,
      webAppURL: config.auth.webAppURL,
      log: c.var.log,
      // Per person, across their agents: a key apart from the app's per-member limits.
      rateLimit: (rule: RateLimitRule, cost?: number) =>
        checkRateLimit(c.env, config, rule, `mcp:${caller.userId}`, cost),
    };
    const handler = createMcpHandler(() => createServer(context), {
      legacy: "stateless",
      responseMode: "json",
      onerror: (error) => c.var.log.warn("mcp.error", { error: error.message }),
    });
    const response = await handler.fetch(c.req.raw, {
      authInfo: {
        token: caller.token,
        clientId: caller.clientId,
        scopes: [...caller.scopes],
        expiresAt: caller.expiresAt,
      },
    });
    // 2025-era requests are answered as a stream even with one message in it. Read it to the end
    // here: the request's database connection closes once this handler returns.
    return new Response(await response.arrayBuffer(), response);
  })
  // No sessions and no server-sent stream: there is nothing to GET or DELETE.
  .on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { allow: "POST" }))
  // RFC 9728 and RFC 8414 / OIDC discovery, at the root where clients look for them.
  .get("/.well-known/*", (c) => c.var.auth.handler(c.req.raw));
