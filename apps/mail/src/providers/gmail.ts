// Personal Gmail through Google OAuth (ADR 0023). The mail service is the only holder of the
// tokens: it exchanges the authorization code the Worker forwards, stores the refresh token
// encrypted in the mailbox's credentials, and mints short-lived access tokens for XOAUTH2 on
// IMAP and SMTP. Endpoints follow Google's OAuth 2.0 web-server flow
// (https://developers.google.com/identity/protocols/oauth2/web-server).
import { randomUUIDv7 } from "node:crypto";
import type { GoogleConnectBody, GoogleConnectResult } from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, findOrgMailbox, mailboxOwnerIds, saveMailbox } from "@omni/db";
import { z } from "zod";
import type { GoogleCredentials } from "../credentials.ts";
import { sealCredentials } from "../credentials.ts";
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
 * also carry `access_type=offline` and `prompt=consent`, or Google returns no refresh token. The
 * Worker's consent redirect asks for the same three.
 */
export const GOOGLE_MAIL_SCOPES = [MAIL_SCOPE, "openid", "email"] as const;
/** An access token this close to expiry is refreshed before use, so a login never races it. */
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
});

export function createGoogleOAuth(
  client: { clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): GoogleOAuth {
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
      // RFC 6749 §5.2: the grant (code or refresh token) is invalid, expired or revoked.
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
      // A person can untick Gmail on the consent screen; the sign-in scopes alone are useless here.
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
      // Received straight from Google's token endpoint over TLS, so the signature check can be
      // skipped (OpenID Connect Core §3.1.3.7); the audience and issuer still must match.
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
      };
    },

    async refresh(refreshToken) {
      const data = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
      return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    },

    async revoke(value) {
      const response = await fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value }),
        signal: AbortSignal.timeout(20_000),
      });
      // 400 invalid_token: already revoked or expired, which is the state we wanted.
      if (!response.ok && response.status !== 400) {
        throw new GoogleOAuthError(`http_${response.status}`, "revoke failed");
      }
    },
  };
}

/**
 * Access tokens for one mailbox: the cached one while it has more than 5 minutes left, else one
 * refresh shared by every caller waiting on it. Lives in memory only; a restart refreshes once.
 */
export function googleTokenSource(oauth: GoogleOAuth, credentials: GoogleCredentials): TokenSource {
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
}

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
): Promise<GoogleConnectResult> {
  const { oauth, logger } = deps;
  let grant: GoogleGrant;
  try {
    grant = await oauth.exchangeCode(input);
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    // A used, expired or mistyped code: the person starts again from the Connect button.
    if (error instanceof GoogleGrantRevoked) {
      throw new ProvisionError(422, "Google refused the sign-in code: connect again");
    }
    logger.warn("google.exchange_failed", { error });
    throw new ProvisionError(502, "Google could not be reached: try again");
  }

  // One save per account at a time: two consent flows finishing together would otherwise both
  // see no mailbox and race on (org, address), and the loser's code is already spent.
  const key = `${input.orgId}\n${grant.email}`;
  const previous = saving.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => save(deps, input, grant));
  saving.set(key, run);
  try {
    return await run;
  } finally {
    if (saving.get(key) === run) saving.delete(key);
  }
}

/** Saves in flight per (org, address). This service runs as one machine (ADR 0004). */
const saving = new Map<string, Promise<GoogleConnectResult>>();

async function save(
  deps: Parameters<typeof connectGoogle>[0],
  input: GoogleConnectBody,
  grant: GoogleGrant,
): Promise<GoogleConnectResult> {
  const { db, keyring, logger } = deps;
  const address = grant.email;
  const existing = await findOrgMailbox(db, input.orgId, address);
  if (existing && existing.provider !== "gmail") {
    throw new ProvisionError(409, `${address} is already a mailbox in this workspace`);
  }
  // A personal mailbox has one owner. Another member consenting with the same Google account
  // must not gain access to it, nor restore access after its owner's grant was revoked.
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
  });
  logger.info("google.connected", { orgId: input.orgId, mailboxId, reconnect: !!existing });
  void deps
    .connect(mailboxId)
    .catch((error: unknown) => logger.error("mailbox.connect_failed", { mailboxId, error }));
  return { mailboxId, address, created: !existing };
}

/** The scopes as Google's authorization URL wants them. */
export const GOOGLE_SCOPE_PARAM = GOOGLE_MAIL_SCOPES.join(" ");

function decodeJwtPayload(jwt: string): unknown {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
