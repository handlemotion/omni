// Rate limits for abuse-prone routes (sign-in, invitations, search, sending, mail service calls,
// image proxy fetches, Storage's share mail and link door).
// One Durable Object instance per (rule, key), so every count is strongly consistent and a busy
// key never slows another. Fixed windows: simple, and exact enough for abuse control.
import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "@omni/crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context.ts";
import type { Config, RateLimit } from "./env.ts";
import { apiError } from "./errors.ts";

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
  storageShare: "RATE_LIMIT_STORAGE_SHARE",
  storageLink: "RATE_LIMIT_STORAGE_LINK",
} as const satisfies Record<string, keyof Config>;

export type RateLimitRule = keyof typeof RULES;

export class RateLimiter extends DurableObject<Env> {
  /**
   * Counts `cost` hits (one by default: a batch counts each of its items) if the window has room
   * for all of them. Returns 0 when allowed, otherwise the seconds until the window resets.
   * Refused hits are not counted, so a client that waits gets in again.
   */
  async hit(limit: number, windowSeconds: number, cost = 1): Promise<number> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    let state = await this.ctx.storage.get<{ start: number; count: number }>("window");
    if (!state || now >= state.start + windowMs) state = { start: now, count: 0 };
    if (state.count + cost > limit) {
      return Math.max(1, Math.ceil((state.start + windowMs - now) / 1000));
    }
    state.count += cost;
    await this.ctx.storage.put("window", state);
    // Nothing outlives its window: the alarm clears this instance's storage.
    await this.ctx.storage.setAlarm(state.start + windowMs);
    return 0;
  }

  override async alarm() {
    await this.ctx.storage.deleteAll();
  }
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
  cost = 1,
): Promise<number> {
  const limit: RateLimit = config[RULES[rule]];
  if (!limit) return 0;
  const name = await sha256Hex(`${rule}:${key}`);
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
  return stub.hit(limit.count, limit.windowSeconds, cost);
}

/**
 * 429 `rate_limited` after `rule` refused for `retryAfter` seconds: `retry-after`, the
 * `X-RateLimit-*` headers and `error.limit` (ADR 0038). The refused hit was not counted and the
 * window is full, so nothing remains until it resets.
 */
export function tooManyRequests(c: Context<AppEnv>, retryAfter: number, rule: RateLimitRule) {
  const total = c.var.config[RULES[rule]]?.count;
  const resetMs = Date.now() + retryAfter * 1000;
  const limit = { remaining: 0, reset: Math.ceil(resetMs / 1000), resetMs, total };
  c.header("retry-after", String(retryAfter));
  if (total !== undefined) c.header("x-ratelimit-limit", String(total));
  c.header("x-ratelimit-remaining", "0");
  c.header("x-ratelimit-reset", String(limit.reset));
  return apiError(c, "rate_limited", "too many requests", { limit });
}

/** The rule that refused longest among `checks`, run together; null when all allowed. */
export async function longestWait(checks: [RateLimitRule, Promise<number>][]) {
  const waits = await Promise.all(checks.map(async ([rule, wait]) => ({ rule, wait: await wait })));
  const longest = waits.reduce((a, b) => (b.wait > a.wait ? b : a));
  return longest.wait ? longest : null;
}

/** The caller's IP as Cloudflare saw it. Clients cannot set this header through Cloudflare. */
export function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Limits a member route per member. Mount after `requireMember`. */
export function limitPerMember(rule: RateLimitRule) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const wait = await checkRateLimit(c.env, c.var.config, rule, c.var.member.id);
    if (wait) return tooManyRequests(c, wait, rule);
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

  const checks: [RateLimitRule, Promise<number>][] = [
    ["auth", checkRateLimit(env, config, "auth", clientIp(c.req.raw))],
  ];
  if (c.req.method === "POST" && path === "/sign-in/magic-link") {
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email === "string") {
      checks.push([
        "magicLink",
        checkRateLimit(env, config, "magicLink", body.email.trim().toLowerCase()),
      ]);
    }
  }
  if (c.req.method === "POST" && path === "/organization/invite-member") {
    const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
    if (session) checks.push(["invite", checkRateLimit(env, config, "invite", session.user.id)]);
  }
  const refused = await longestWait(checks);
  if (refused) return tooManyRequests(c, refused.wait, refused.rule);
  await next();
});
