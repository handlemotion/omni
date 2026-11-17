import {
  listSignInEmails,
  removeSignInEmail,
  setPrimarySignInEmail,
  startSignInEmail,
  verifySignInEmail,
} from "@omni/db";
import { normalizeAddress } from "@omni/mail-core/addresses";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { resolveSession, systemMailSender, type AppEnv, type SessionUser } from "../context.ts";
import {
  checkRateLimit,
  clientIp,
  longestWait,
  tooManyRequests,
  type RateLimitRule,
} from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";

const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  if (resolved.user.scopeOrgId && c.req.method !== "GET") {
    throw new HTTPException(403, { message: "signed in with a work address: sign in another way" });
  }
  c.set("user", resolved.user);
  await next();
});

const limit = (perAddress?: "magicLink") =>
  createMiddleware<AppEnv>(async (c, next) => {
    const checks: [RateLimitRule, Promise<number>][] = [
      ["auth", checkRateLimit(c.env, c.var.config, "auth", clientIp(c.req.raw))],
    ];
    if (perAddress) {
      const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
      if (typeof body?.email === "string") {
        checks.push([
          perAddress,
          checkRateLimit(c.env, c.var.config, perAddress, normalizeAddress(body.email)),
        ]);
      }
    }
    const refused = await longestWait(checks);
    if (refused) return tooManyRequests(c, refused.wait, refused.rule);
    await next();
  });

const emailBody = z.object({ email: z.email().max(320) });

export const account = new Hono<AppEnv>()
  .use(requireUser)

  .get("/emails", async (c) => c.json({ emails: await listSignInEmails(c.var.db, c.var.user.id) }))

  .post("/emails", zValidator("json", emailBody), limit("magicLink"), async (c) => {
    const user: SessionUser = c.var.user;
    const email = normalizeAddress(c.req.valid("json").email);

    const started = await startSignInEmail(c.var.db, { userId: user.id, email });
    if (started.status === "yours") {
      throw new HTTPException(409, { message: "this address already signs in to your account" });
    }
    if (started.status === "sent") {
      const { config } = c.var;
      const url = new URL("/settings/emails/verify", config.auth.webAppURL);
      url.searchParams.set("token", started.token);
      await systemMailSender({ email: c.env.EMAIL, config, log: c.var.log })({
        to: email,
        subject: `Confirm your sign-in email for ${config.auth.appName}`,
        text: [
          `${user.email} asked to sign in to ${config.auth.appName} with this address too.`,
          "",
          "Open this link in the browser where you are signed in to confirm:",
          "",
          url.toString(),
          "",
          "It works once and expires in an hour. If you did not ask for it, ignore this email.",
        ].join("\n"),
      });
    }
    return c.json({ status: "sent" as const, email });
  })

  .post(
    "/emails/verify",
    zValidator("json", z.object({ token: z.string().min(1).max(200) })),
    limit(),
    async (c) => {
      const result = await verifySignInEmail(c.var.db, {
        userId: c.var.user.id,
        token: c.req.valid("json").token,
      });
      if (result.status === "invalid") {
        throw new HTTPException(400, { message: "this link is invalid, used or expired" });
      }
      if (result.status === "wrong_user") {
        throw new HTTPException(403, {
          message: "this link is for another account: sign in as the account that asked for it",
        });
      }
      if (result.status === "taken") {
        throw new HTTPException(409, { message: "another account already signs in with it" });
      }
      return c.json({ email: result.email });
    },
  )

  .post("/emails/primary", zValidator("json", emailBody), async (c) => {
    const result = await setPrimarySignInEmail(c.var.db, {
      userId: c.var.user.id,
      email: c.req.valid("json").email,
    });
    if (result.status === "not_found") {
      throw new HTTPException(404, { message: "not one of your verified sign-in emails" });
    }
    return c.json({ ok: true as const });
  })

  .delete("/emails/:email", async (c) => {
    const result = await removeSignInEmail(c.var.db, {
      userId: c.var.user.id,
      email: c.req.param("email"),
    });
    if (result.status === "not_found") {
      throw new HTTPException(404, { message: "not one of your sign-in emails" });
    }
    if (result.status === "primary") {
      throw new HTTPException(409, { message: "make another address primary first" });
    }
    if (result.status === "last_verified") {
      throw new HTTPException(409, { message: "keep at least one verified address" });
    }
    return c.json({ ok: true as const });
  });
