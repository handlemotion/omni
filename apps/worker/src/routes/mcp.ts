import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { authenticate, insufficientScope } from "../mcp/auth.ts";
import { checkRateLimit, type RateLimitRule } from "../rate-limiter.ts";
import { createServer, TOOL_SCOPES } from "../mcp/server.ts";
import { skills } from "../mcp/skills.ts";

function originAllowed(origin: string | undefined, allowed: string[]) {
  return origin === undefined || allowed.includes(origin);
}

function toolScopes(body: unknown) {
  const scopes = new Set<string>();
  for (const message of Array.isArray(body) ? body : [body]) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call") continue;
    const scope = typeof params?.name === "string" ? TOOL_SCOPES.get(params.name) : undefined;
    if (!scope) return null;
    scopes.add(scope);
  }
  return [...scopes];
}

export const mcp = new Hono<AppEnv>()
  .post("/mcp", async (c) => {
    const { config, auth, db, log } = c.var;
    const baseURL = config.auth.baseURL;
    const allowed = [new URL(baseURL).origin, ...config.auth.trustedOrigins];
    if (!originAllowed(c.req.header("origin"), allowed)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    const caller = await authenticate(c.req.raw, auth, db, baseURL);
    if (caller instanceof Response) return caller;
    const needed = toolScopes(
      await c.req.raw
        .clone()
        .json()
        .catch(() => null),
    );
    if (!needed) {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32602, message: "Unknown tool" } },
        400,
      );
    }
    const missing = needed.filter((scope) => !caller.scopes.has(scope));
    if (missing.length) return insufficientScope(baseURL, missing, caller.scopes);
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
      rateLimit: (rule: RateLimitRule, cost?: number) =>
        checkRateLimit(c.env, config, rule, `mcp:${caller.userId}`, cost),
    };
    const catalog = await skills();
    const handler = createMcpHandler(() => createServer(context, catalog), {
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
    return new Response(await response.arrayBuffer(), response);
  })
  .on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { allow: "POST" }))
  .get("/.well-known/*", (c) => c.var.auth.handler(c.req.raw));
