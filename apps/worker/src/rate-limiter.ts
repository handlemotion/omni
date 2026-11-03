// Rate limits for abuse-prone routes (sign-in, invitations, search, sending, mail service calls,
// image proxy fetches).
// One Durable Object instance per (rule, key), so every count is strongly consistent and a busy
// key never slows another. Fixed windows: simple, and exact enough for abuse control.
import { DurableObject } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context.ts";
import type { Config, RateLimit } from "./env.ts";

/** Each rule and the variable that sets it. */
const RULES = {
  auth: "RATE_LIMIT_AUTH",
  magicLink: "RATE_LIMIT_MAGIC_LINK",
  invite: "RATE_LIMIT_INVITE",
  search: "RATE_LIMIT_SEARCH",
  send: "RATE_LIMIT_SEND",
  actions: "RATE_LIMIT_ACTIONS",
  provision: "RATE_LIMIT_PROVISION",
  imageProxy: "RATE_LIMIT_IMAGE_PROXY",
} as const satisfies Record<string, keyof Config>;

export type RateLimitRule = keyof typeof RULES;

export class RateLimiter extends DurableObject<Env> {
  /**
   * Counts one hit if the window has room. Returns 0 when allowed, otherwise the seconds until
   * the window resets. Refused hits are not counted, so a client that waits gets in again.
   */
  async hit(limit: number, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    let state = await this.ctx.storage.get<{ start: number; count: number }>("window");
    if (!state || now >= state.start + windowMs) state = { start: now, count: 0 };
    if (state.count >= limit) return Math.max(1, Math.ceil((state.start + windowMs - now) / 1000));
    state.count += 1;
    await this.ctx.storage.put("window", state);
    // Nothing outlives its window: the alarm clears this instance's storage.
    await this.ctx.storage.setAlarm(state.start + windowMs);
    return 0;
  }

  override async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Seconds to wait, or 0 if the hit is allowed. Keys are hashed so no address or IP becomes a
 * Durable Object name. A disabled rule (`off`) always allows.
 */
export async function checkRateLimit(
  env: Env,
  config: Config,
  rule: RateLimitRule,
  key: string,
): Promise<number> {
  const limit: RateLimit = config[RULES[rule]];
  if (!limit) return 0;
  const name = await sha256Hex(`${rule}:${key}`);
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
  return stub.hit(limit.count, limit.windowSeconds);
}

export function tooManyRequests(retryAfter: number) {
  return Response.json(
    { error: "too many requests" },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

/** The caller's IP as Cloudflare saw it. Clients cannot set this header through Cloudflare. */
export function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Limits a member route per member. Mount after `requireMember`. */
export function limitPerMember(rule: RateLimitRule) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const wait = await checkRateLimit(c.env, c.var.config, rule, c.var.member.id);
    if (wait) return tooManyRequests(wait);
    await next();
  });
}

/**
 * Better Auth's routes. Every sign-in step (magic link, its verify link, passkey options and
 * verification, Google start and callback) counts per IP; reads like `get-session` do not.
 * A magic-link request also counts per address, so nobody can mail-bomb an inbox through our
 * no-reply mailbox, and an invitation counts per inviting user, since each one sends mail.
 */
export const limitAuth = createMiddleware<AppEnv>(async (c, next) => {
  const { env } = c;
  const { config } = c.var;
  const path = new URL(c.req.url).pathname.replace(/^\/api\/auth/, "");
  const signInStep = c.req.method === "POST" || /^\/(callback|magic-link|passkey)\//.test(path);
  if (!signInStep) return next();

  const checks: Promise<number>[] = [checkRateLimit(env, config, "auth", clientIp(c.req.raw))];
  if (c.req.method === "POST" && path === "/sign-in/magic-link") {
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email === "string") {
      checks.push(checkRateLimit(env, config, "magicLink", body.email.trim().toLowerCase()));
    }
  }
  if (c.req.method === "POST" && path === "/organization/invite-member") {
    const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
    if (session) checks.push(checkRateLimit(env, config, "invite", session.user.id));
  }
  const wait = Math.max(...(await Promise.all(checks)));
  if (wait) return tooManyRequests(wait);
  await next();
});
