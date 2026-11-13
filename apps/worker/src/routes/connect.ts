// Connecting a personal Google account (helpdesk plan G3). The Worker runs the browser side of
// OAuth: it sends the member to Google's consent screen with PKCE and, on the callback, hands the
// one-time code to the mail service over a signed call. The mail service exchanges it and keeps
// the refresh token; the Worker never holds a Google token.
import {
  GOOGLE_CONNECT_PATH,
  GOOGLE_DISCONNECT_PATH,
  googleConnectResultSchema,
  googleDisconnectResultSchema,
} from "@omni/contracts";
import { advanceOrgSetup, forUser } from "@omni/db";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppEnv } from "../context.ts";
import { callMailService, MailServiceError } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { notFound } from "./mail.ts";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
/** Full IMAP and SMTP access (XOAUTH2), and the address to name the mailbox by. */
const SCOPES = ["https://mail.google.com/", "openid", "email"];
const COOKIE = "omni_google_connect";
const COOKIE_PATH = "/api/connect/google";

/** Base64url without padding, as PKCE and OAuth state use. */
function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function redirectUri(c: Context<AppEnv>) {
  return new URL(`${COOKIE_PATH}/callback`, c.var.config.auth.baseURL).toString();
}

/** Where a flow can return to: onboarding's inbox step, or Settings, Connected accounts. */
const RETURNS = { onboarding: "/onboarding", settings: "/settings/accounts" } as const;
type Return = keyof typeof RETURNS;

/** Where the browser lands afterwards: the page that started the flow, with the outcome. */
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

/**
 * The person's Google accounts, in every workspace they connected one to (ADR 0024), or only in
 * the company a scoped session reaches.
 */
function googleMailboxes(c: Context<AppEnv>) {
  return forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId).googleAccounts();
}

export const connect = new Hono<AppEnv>()
  /** Whether this install can connect Google (an OAuth client is set) and what is connected. */
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

  /**
   * Starts the consent flow: a top-level navigation here redirects to Google. The state and PKCE
   * verifier ride a short-lived signed cookie, bound to this member, scoped to these routes.
   * `?return=onboarding` brings the browser back to setup instead of Settings.
   */
  .get("/google/start", limitPerMember("provision"), async (c) => {
    const google = c.var.config.auth.google;
    if (!google)
      return c.json({ error: "Google is not configured", requestId: c.var.requestId }, 404);
    const state = randomToken(24);
    const verifier = randomToken(48);
    const back: Return = c.req.query("return") === "onboarding" ? "onboarding" : "settings";
    // `?place=address`: the account goes where its address belongs, the company that locked its
    // domain or the person's Personal space (ADR 0024). Without it, it joins this workspace, as
    // clients from before ADR 0024 expect.
    const byAddress = c.req.query("place") === "address";
    // Pin setup where it stands before the mail service saves a mailbox: a workspace with a
    // mailbox and no setup row reads as finished (`orgSetupStep`), which would skip the rest of
    // setup. An org that already has a mailbox keeps the step it reads as now.
    await advanceOrgSetup(c.var.db, c.var.member.orgId, "created");
    await setSignedCookie(
      c,
      COOKIE,
      JSON.stringify({ state, verifier, memberId: c.var.member.id, back, byAddress }),
      c.var.config.auth.secret,
      {
        path: COOKIE_PATH,
        httpOnly: true,
        secure: new URL(c.var.config.auth.baseURL).protocol === "https:",
        // Lax: sent on Google's top-level redirect back, never on a cross-site subrequest.
        sameSite: "Lax",
        maxAge: 600,
      },
    );
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: redirectUri(c),
      response_type: "code",
      scope: SCOPES.join(" "),
      // A refresh token, every time: the mail service needs one to sync while nobody is here.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(url.toString(), 302);
  })

  /**
   * Google sends the browser back here. The state must match the cookie this browser got from
   * `/start` for this same member; then the code goes to the mail service, signed. Counted with
   * `/start`, so a kept copy of the cookie cannot be replayed into unlimited mail service calls.
   */
  .get("/google/callback", limitPerMember("provision"), async (c) => {
    const raw = await getSignedCookie(c, c.var.config.auth.secret, COOKIE);
    deleteCookie(c, COOKIE, { path: COOKIE_PATH });
    let flow: {
      state?: string;
      verifier?: string;
      memberId?: string;
      back?: Return;
      byAddress?: boolean;
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
          ...(flow.byAddress
            ? {
                userId: c.var.user.id,
                ...(c.var.user.scopeOrgId ? { scopeOrgId: c.var.user.scopeOrgId } : {}),
              }
            : {}),
          code,
          codeVerifier: flow.verifier,
          redirectUri: redirectUri(c),
        },
        googleConnectResultSchema,
      );
      // A connected Gmail is an inbox to read: this workspace's setup can finish now, if that is
      // where it landed.
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

  /** Disconnects one of the member's Google accounts: revoked at Google, no longer synced. */
  .delete("/google/:mailboxId", limitPerMember("provision"), async (c) => {
    const mailboxId = c.req.param("mailboxId");
    const account = (await googleMailboxes(c)).find((m) => m.id === mailboxId);
    if (!account) notFound();
    try {
      // The account's own workspace and member, so a mail service from before ADR 0024 (which
      // ignores `userId`) finds it too.
      await callMailService(
        c.var,
        GOOGLE_DISCONNECT_PATH,
        { orgId: account.orgId, memberId: account.memberId, mailboxId, userId: c.var.user.id },
        googleDisconnectResultSchema,
      );
    } catch (failure) {
      if (!(failure instanceof MailServiceError)) throw failure;
      return c.json({ error: failure.message, requestId: c.var.requestId }, failure.status);
    }
    return c.body(null, 204);
  });
