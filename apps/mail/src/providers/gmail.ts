import { randomUUIDv7 } from "node:crypto";
import type {
  GoogleConnectBody,
  GoogleConnectResult,
  GoogleDisconnectBody,
  googleDisconnectResultSchema,
} from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import {
  type Db,
  deleteMailbox,
  findGmailMailboxes,
  findOrgMailbox,
  findOrgMailboxById,
  forUser,
  mailboxOwnerIds,
  placeForAddress,
  saveMailbox,
  setMailboxStatus,
} from "@omni/db";
import { z } from "zod";
import type { GoogleCredentials } from "../credentials.ts";
import { openCredentials, sealCredentials } from "../credentials.ts";
import type { Logger } from "../log.ts";
import type { ServerEndpoint, TokenSource } from "../mailbox-connection.ts";
import { ProvisionError } from "../provisioning.ts";

export const GMAIL_SERVERS: { imap: ServerEndpoint; smtp: ServerEndpoint } = {
  imap: { host: "imap.gmail.com", port: 993, secure: true },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const MAIL_SCOPE = "https://mail.google.com/";

/**
 * Scopes to ask Google for. `https://mail.google.com/` is the only scope Gmail's IMAP and SMTP
 * accept (a restricted scope: unverified apps are capped at 100 users). The authorization URL must
 * also carry `access_type=offline` and `prompt=consent`, or Google returns no refresh token.
 * `profile` brings the account's photo and name (the id token's `picture`, `name`) for its inbox.
 * `calendar.events.readonly` lets the calendar show the account's own Google Calendar; it is
 * optional, and mail works without it. The Worker's consent redirect asks for the same five
 * (the calendar one unless `GOOGLE_CALENDAR=off`).
 */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_MAIL_SCOPES = [
  MAIL_SCOPE,
  "openid",
  "email",
  "profile",
  GOOGLE_CALENDAR_SCOPE,
] as const;
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Google refused the refresh token: the person revoked access, or it expired. Only reconnecting fixes it. */
export class GoogleGrantRevoked extends Error {
  override name = "GoogleGrantRevoked";
}

/** Google answered with an error we cannot act on (bad client config, outage). */
export class GoogleOAuthError extends Error {
  override name = "GoogleOAuthError";
  readonly code: string;
  constructor(code: string, description: string) {
    super(`Google OAuth: ${code}${description ? ` (${description})` : ""}`);
    this.code = code;
  }
}

export interface AccessToken {
  value: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface GoogleGrant extends AccessToken {
  refreshToken: string;
  /** The address Google verified for this account. */
  email: string;
  /** The account's profile photo, when Google sent one. */
  picture?: string;
  /** The account's display name, when Google sent one. */
  name?: string;
}

export interface GoogleOAuth {
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<GoogleGrant>;
  refresh(refreshToken: string): Promise<AccessToken>;
  /** Revokes the grant at Google (every token it issued). Best effort for the caller. */
  revoke(token: string): Promise<void>;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

const errorResponse = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const idTokenClaims = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  email: z.string().min(3),
  email_verified: z.boolean(),
  picture: z.url().optional(),
  name: z.string().trim().min(1).max(80).optional().catch(undefined),
});

export function createGoogleOAuth(
  client: { clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
) {
  async function token(params: Record<string, string>) {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = errorResponse.safeParse(json);
      const code = error.success ? error.data.error : `http_${response.status}`;
      if (code === "invalid_grant") throw new GoogleGrantRevoked("Google refused the grant");
      throw new GoogleOAuthError(code, error.success ? (error.data.error_description ?? "") : "");
    }
    const parsed = tokenResponse.safeParse(json);
    if (!parsed.success) throw new GoogleOAuthError("bad_response", "unexpected token response");
    return parsed.data;
  }

  return {
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const data = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      });
      const granted = new Set((data.scope ?? "").split(" "));
      if (!granted.has(MAIL_SCOPE)) {
        throw new ProvisionError(422, "Omni needs access to Gmail: allow it on Google's screen");
      }
      if (!data.refresh_token) {
        throw new ProvisionError(
          422,
          "Google sent no refresh token: the request needs access_type=offline and prompt=consent",
        );
      }
      if (!data.id_token) throw new GoogleOAuthError("bad_response", "no id_token");
      const claims = idTokenClaims.safeParse(decodeJwtPayload(data.id_token));
      if (!claims.success || claims.data.aud !== client.clientId) {
        throw new GoogleOAuthError("bad_response", "id_token is not for this client");
      }
      if (!claims.data.email_verified) {
        throw new ProvisionError(422, "Google has not verified this account's email address");
      }
      return {
        value: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        refreshToken: data.refresh_token,
        email: claims.data.email.toLowerCase(),
        ...(claims.data.picture?.startsWith("https://") ? { picture: claims.data.picture } : {}),
        ...(claims.data.name ? { name: claims.data.name } : {}),
      };
    },

    async refresh(refreshToken) {
      const data = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
      return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    },

    revoke: (value) => revokeGoogleToken(value, fetchImpl),
  } satisfies GoogleOAuth;
}

/**
 * Revokes a token at Google, and with it the whole grant (a refresh token's access tokens too).
 * Needs no client credentials, so a mailbox can be disconnected after the client was removed.
 */
export async function revokeGoogleToken(value: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: value }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 400) {
    throw new GoogleOAuthError(`http_${response.status}`, "revoke failed");
  }
}

/**
 * Access tokens for one mailbox: the cached one while it has more than 5 minutes left, else one
 * refresh shared by every caller waiting on it. Lives in memory only; a restart refreshes once.
 */
export const googleTokenSource: (
  oauth: GoogleOAuth,
  credentials: GoogleCredentials,
) => TokenSource = (oauth, credentials) => {
  let cached: AccessToken | null =
    credentials.accessToken && credentials.accessTokenExpiresAt
      ? { value: credentials.accessToken, expiresAt: credentials.accessTokenExpiresAt }
      : null;
  let refreshing: Promise<string> | null = null;
  return {
    get() {
      if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
        return Promise.resolve(cached.value);
      }
      refreshing ??= oauth
        .refresh(credentials.refreshToken)
        .then((next) => {
          cached = next;
          return next.value;
        })
        .finally(() => {
          refreshing = null;
        });
      return refreshing;
    },
    invalidate() {
      cached = null;
    },
    isRevoked: (error) => error instanceof GoogleGrantRevoked,
  };
};

/**
 * Exchanges the code and saves the account as a personal mailbox, then connects it. A Gmail
 * address needs no domain claim: Google vouched for it, and only its owner could consent.
 */
export async function connectGoogle(
  deps: {
    db: Db;
    keyring: Keyring;
    oauth: GoogleOAuth;
    /** Where IMAP and SMTP live; Gmail's in production. */
    servers?: { imap: ServerEndpoint; smtp: ServerEndpoint };
    connect(mailboxId: string): Promise<void>;
    logger: Logger;
  },
  input: GoogleConnectBody,
) {
  const { oauth, logger } = deps;
  let grant: GoogleGrant;
  try {
    grant = await oauth.exchangeCode(input);
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    if (error instanceof GoogleGrantRevoked) {
      throw new ProvisionError(400, "Google refused the sign-in code: connect again");
    }
    logger.warn("google.exchange_failed", { error });
    throw new ProvisionError(502, "Google could not be reached: try again");
  }

  const key = grant.email;
  const previous = saving.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => save(deps, input, grant));
  saving.set(key, run);
  try {
    return (await run) satisfies GoogleConnectResult;
  } finally {
    if (saving.get(key) === run) saving.delete(key);
  }
}

const saving = new Map<string, Promise<GoogleConnectResult>>();

async function save(
  deps: Parameters<typeof connectGoogle>[0],
  input: GoogleConnectBody,
  grant: GoogleGrant,
) {
  const { db, keyring, logger } = deps;
  const address = grant.email;
  input = await placeByAddress(db, input, address);
  const elsewhere = await findGmailMailboxes(db, address);
  if (elsewhere.some((row) => row.orgId !== input.orgId)) {
    throw new ProvisionError(409, `${address} is connected in another workspace`);
  }
  const existing = await findOrgMailbox(db, input.orgId, address);
  if (existing && existing.provider !== "gmail") {
    throw new ProvisionError(409, `${address} is already a mailbox in this workspace`);
  }
  if (existing) {
    const owners = await mailboxOwnerIds(db, existing.id);
    if (!owners.includes(input.memberId)) {
      throw new ProvisionError(409, `${address} is connected by someone else in this workspace`);
    }
  }
  const mailboxId = existing?.id ?? randomUUIDv7();
  const credentials: GoogleCredentials = {
    oauth: "google",
    user: address,
    refreshToken: grant.refreshToken,
    accessToken: grant.value,
    accessTokenExpiresAt: grant.expiresAt,
    ...(deps.servers ?? GMAIL_SERVERS),
  };
  await saveMailbox(db, {
    id: mailboxId,
    orgId: input.orgId,
    address,
    kind: "personal",
    provider: "gmail",
    credentialsEnc: await sealCredentials(keyring, mailboxId, credentials),
    ownerMemberId: input.memberId,
    ...(grant.picture ? { picture: grant.picture } : {}),
    ...(grant.name ? { senderName: grant.name } : {}),
  });
  logger.info("google.connected", { orgId: input.orgId, mailboxId, reconnect: !!existing });
  void deps
    .connect(mailboxId)
    .catch((error: unknown) => logger.error("mailbox.connect_failed", { mailboxId, error }));
  const result: GoogleConnectResult = {
    mailboxId,
    address,
    created: !existing,
    orgId: input.orgId,
  };
  return result;
}

const PLACEMENT_REFUSALS = {
  not_a_member: "belongs to a workspace you are not a member of",
  outside_scope: "belongs elsewhere: sign in another way to connect it",
} as const;

const placeByAddress: (
  db: Db,
  input: GoogleConnectBody,
  address: string,
) => Promise<GoogleConnectBody> = async (db, input, address) => {
  if (!input.userId) return input;
  const place = await placeForAddress(db, {
    userId: input.userId,
    address,
    scopeOrgId: input.scopeOrgId,
  });
  if (!place.ok) throw new ProvisionError(409, `${address} ${PLACEMENT_REFUSALS[place.reason]}`);
  return { ...input, orgId: place.orgId, memberId: place.memberId };
};

/** The scopes as Google's authorization URL wants them. */
export const GOOGLE_SCOPE_PARAM = GOOGLE_MAIL_SCOPES.join(" ");

/**
 * Disconnects a member's Google account: Omni stops syncing it, revokes the grant at Google and
 * deletes the mailbox with everything indexed from it (Gmail still holds the mail). Only the
 * mailbox's owner can, and a mailbox already gone answers as disconnected, so a retry is safe.
 */
export const disconnectGoogle: (
  deps: {
    db: Db;
    keyring: Keyring;
    /** Stops the mailbox's connection and waits for outbox work already running on it. */
    stop(mailboxId: string): Promise<void>;
    logger: Logger;
  },
  input: GoogleDisconnectBody,
) => Promise<z.infer<typeof googleDisconnectResultSchema>> = async (deps, input) => {
  const { db, logger } = deps;
  if (input.userId) {
    const owned = (await forUser(db, input.userId).googleAccounts()).find(
      (account) => account.id === input.mailboxId,
    );
    if (!owned) return { mailboxId: input.mailboxId };
    input = { ...input, orgId: owned.orgId, memberId: owned.memberId };
  }
  const mailbox = await findOrgMailboxById(db, input.orgId, input.mailboxId);
  if (!mailbox) return { mailboxId: input.mailboxId };
  const owners = await mailboxOwnerIds(db, mailbox.id);
  if (
    mailbox.provider !== "gmail" ||
    mailbox.kind !== "personal" ||
    !owners.includes(input.memberId)
  ) {
    throw new ProvisionError(404, "No such Google account");
  }
  await setMailboxStatus(db, mailbox.id, "disabled");
  await deps.stop(mailbox.id);
  try {
    const credentials = await openCredentials(deps.keyring, mailbox.id, mailbox.credentialsEnc);
    if ("oauth" in credentials) await revokeGoogleToken(credentials.refreshToken);
  } catch (error) {
    logger.warn("google.revoke_failed", { mailboxId: mailbox.id, error });
  }
  await deleteMailbox(db, mailbox.id);
  logger.info("google.disconnected", { orgId: input.orgId, mailboxId: mailbox.id });
  return { mailboxId: mailbox.id };
};

function decodeJwtPayload(jwt: string) {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
