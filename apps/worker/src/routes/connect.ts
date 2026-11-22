import {
  GOOGLE_CONNECT_PATH,
  GOOGLE_DISCONNECT_PATH,
  googleConnectResultSchema,
  googleDisconnectResultSchema,
} from "@omni/contracts";
import { advanceOrgSetup, forUser } from "@omni/db";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { callMailService, MailServiceError } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { notFound } from "./mail.ts";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = ["https://mail.google.com/", "openid", "email", "profile"];
const CALENDAR_SCOPES = {
  off: [],
  on: ["https://www.googleapis.com/auth/calendar.events.readonly"],
  all: [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  ],
} as const;
const COOKIE = "omni_google_connect";
const COOKIE_PATH = "/api/connect/google";

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function redirectUri(c: Context<AppEnv>) {
  return new URL(`${COOKIE_PATH}/callback`, c.var.config.auth.baseURL).toString();
}

const RETURNS = { onboarding: "/onboarding", settings: "/settings/accounts" } as const;
type Return = keyof typeof RETURNS;

function backToApp(c: Context<AppEnv>, back: Return, outcome: Record<string, string>) {
  const url = new URL(RETURNS[back], c.var.config.auth.webAppURL);
  for (const [key, value] of Object.entries(outcome)) url.searchParams.set(key, value);
  return c.redirect(url.toString(), 302);
}

function randomToken(bytes: number) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function googleMailboxes(c: Context<AppEnv>) {
  return forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId).googleAccounts();
}

const DESKTOP_STATE = "d.";
const IN_APP = "in_app";

/**
 * Ahead of the member API. The desktop app opens Google's consent in the person's browser, which
 * has neither the session nor the flow's cookie, so a desktop flow's callback is sent on to the
 * app (`omni://open`), which loads the same callback in its own window, where both are.
 */
export const desktopGoogleReturn = createMiddleware<AppEnv>(async (c, next) => {
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state") ?? "";
  if (!state.startsWith(DESKTOP_STATE) || url.searchParams.has(IN_APP)) return next();
  url.searchParams.set(IN_APP, "1");
  const back = new URL("omni://open");
  back.searchParams.set("path", `${url.pathname}${url.search}`);
  return c.redirect(back.toString(), 302);
});

export const connect = new Hono<AppEnv>()
  .get("/google", async (c) =>
    c.json({
      available: c.var.config.auth.google !== undefined,
      accounts: (await googleMailboxes(c)).map(({ id, address, status }) => ({
        mailboxId: id,
        address,
        status,
      })),
    }),
  )

  .get("/google/start", limitPerMember("provision"), async (c) => {
    const google = c.var.config.auth.google;
    if (!google) return apiError(c, "not_found", "Google is not configured");
    const desktop = c.req.query("desktop") === "1";
    const state = `${desktop ? DESKTOP_STATE : ""}${randomToken(24)}`;
    const verifier = randomToken(48);
    const back: Return = c.req.query("return") === "onboarding" ? "onboarding" : "settings";
    await advanceOrgSetup(c.var.db, c.var.member.orgId, "created");
    await setSignedCookie(
      c,
      COOKIE,
      JSON.stringify({ state, verifier, memberId: c.var.member.id, back }),
      c.var.config.auth.secret,
      {
        path: COOKIE_PATH,
        httpOnly: true,
        secure: new URL(c.var.config.auth.baseURL).protocol === "https:",
        sameSite: "Lax",
        maxAge: 600,
      },
    );
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: redirectUri(c),
      response_type: "code",
      scope: [...SCOPES, ...CALENDAR_SCOPES[c.var.config.GOOGLE_CALENDAR]].join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
    }).toString();
    const hint = c.req.query("hint");
    if (hint && hint.length <= 320) url.searchParams.set("login_hint", hint);
    return desktop ? c.json({ url: url.toString() }) : c.redirect(url.toString(), 302);
  })

  .get("/google/callback", limitPerMember("provision"), async (c) => {
    const raw = await getSignedCookie(c, c.var.config.auth.secret, COOKIE);
    deleteCookie(c, COOKIE, { path: COOKIE_PATH });
    let flow: {
      state?: string;
      verifier?: string;
      memberId?: string;
      back?: Return;
    } = {};
    try {
      flow = raw ? (JSON.parse(raw) as typeof flow) : {};
    } catch {
      flow = {};
    }
    const { code, state, error } = c.req.query();
    const back: Return = flow.back === "onboarding" ? "onboarding" : "settings";
    if (!flow.state || !state || flow.state !== state || flow.memberId !== c.var.member.id) {
      return backToApp(c, back, { google: "error", reason: "expired" });
    }
    if (error || !code || !flow.verifier) {
      return backToApp(c, back, {
        google: "error",
        reason: error === "access_denied" ? "denied" : "failed",
      });
    }
    try {
      const connected = await callMailService(
        c.var,
        GOOGLE_CONNECT_PATH,
        {
          orgId: c.var.member.orgId,
          memberId: c.var.member.id,
          userId: c.var.user.id,
          ...(c.var.user.scopeOrgId ? { scopeOrgId: c.var.user.scopeOrgId } : {}),
          ...(c.var.config.auth.billing ? { planCaps: true } : {}),
          code,
          codeVerifier: flow.verifier,
          redirectUri: redirectUri(c),
        },
        googleConnectResultSchema,
      );
      const landed = connected.orgId ?? c.var.member.orgId;
      if (landed === c.var.member.orgId) {
        await advanceOrgSetup(c.var.db, c.var.member.orgId, "mailboxes_created");
      }
      return backToApp(c, back, {
        google: "connected",
        mailboxId: connected.mailboxId,
        ...(connected.orgId ? { workspaceId: connected.orgId } : {}),
      });
    } catch (failure) {
      if (!(failure instanceof MailServiceError)) throw failure;
      return backToApp(c, back, {
        google: "error",
        reason: failure.status === 409 ? "in_use" : "failed",
      });
    }
  })

  .delete("/google/:mailboxId", limitPerMember("provision"), async (c) => {
    const mailboxId = c.req.param("mailboxId");
    const account = (await googleMailboxes(c)).find((m) => m.id === mailboxId);
    if (!account) notFound();
    await callMailService(
      c.var,
      GOOGLE_DISCONNECT_PATH,
      { orgId: account.orgId, memberId: account.memberId, mailboxId, userId: c.var.user.id },
      googleDisconnectResultSchema,
    );
    return c.body(null, 204);
  });
