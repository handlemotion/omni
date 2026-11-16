// Omni as an OAuth 2.1 authorization server for people's own agents (ADR 0029). `mcp()` is the
// provider and serves the protected-resource metadata for `<baseURL>/mcp`; `cimd()` lets Claude and
// ChatGPT identify themselves by a metadata URL; `jwt()` signs access tokens the Worker checks
// against our own keys. Other clients register dynamically.
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { ALL_WORKSPACES, oauthWorkspaceReference, type Db } from "@omni/db";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";

/** Read mail: `inbox`, `search`, `fetch`, `query`. */
export const MAIL_READ_SCOPE = "mail:read";
/** Change per-person and conversation state: `triage`. */
export const MAIL_TRIAGE_SCOPE = "mail:triage";
/** Write drafts for the person to send: `draft_reply`. */
export const MAIL_DRAFT_SCOPE = "mail:draft";
/** Read the CRM of the person's company workspaces: `crm_search`, `crm_fetch` (ADR 0036). */
export const CRM_READ_SCOPE = "crm:read";
/** Add and change CRM records and notes, never delete: `crm_write` (ADR 0036). */
export const CRM_WRITE_SCOPE = "crm:write";

/**
 * Sync Storage with the desktop app's Finder folder (ADR 0043). Only the first-party Omni
 * Desktop client holds it: it is not among the scopes a registered agent may ask for.
 */
export const STORAGE_SYNC_SCOPE = "storage:sync";

/** The first-party desktop app's public client (ADR 0043): PKCE, no secret, no consent screen. */
export const DESKTOP_CLIENT_ID = "omni-desktop";
/** Where the desktop app receives its authorization code: its own `omni://` scheme. */
export const DESKTOP_REDIRECT_URI = "omni://oauth/callback";

/** The sync API, and the resource every desktop sync token is bound to. */
export function storageSyncResource(baseURL: string) {
  return new URL("/api/storage/sync", baseURL).toString();
}

export const MCP_SCOPES = [
  MAIL_READ_SCOPE,
  MAIL_TRIAGE_SCOPE,
  MAIL_DRAFT_SCOPE,
  CRM_READ_SCOPE,
  CRM_WRITE_SCOPE,
] as const;

/** The access-token claim naming the one workspace a grant reaches; absent for every workspace. */
export const WORKSPACE_CLAIM = "omni_workspace";

/** Hosts whose client metadata documents we fetch, unless `MCP_CIMD_HOSTS` says otherwise. */
export const DEFAULT_CIMD_HOSTS = ["claude.ai", "chatgpt.com"];

/**
 * Paths that use the OAuth provider: its endpoints and keys, discovery, the consent screen's
 * workspace pick, and `/mcp`, which checks tokens against its keys.
 */
export function usesOAuthProvider(pathname: string) {
  return (
    pathname === "/mcp" ||
    pathname === "/api/auth/jwks" ||
    pathname.startsWith("/api/auth/oauth2/") ||
    pathname.startsWith("/api/auth/.well-known/") ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/api/oauth/")
  );
}

/** The MCP endpoint, which is also the resource every access token is bound to. */
export function mcpResource(baseURL: string) {
  return new URL("/mcp", baseURL).toString();
}

export interface McpAuthEnv {
  db: Db;
  baseURL: string;
  webAppURL?: string;
  /** Exact hostnames whose CIMD documents may be fetched. */
  cimdHosts?: string[];
}

export function mcpPlugins(env: McpAuthEnv) {
  const cimdHosts = new Set(env.cimdHosts?.length ? env.cimdHosts : DEFAULT_CIMD_HOSTS);
  return [
    // Signs access tokens and publishes `/api/auth/jwks`. No JWT for browser sessions: `/token`
    // is disabled in `createAuth` and the session header is off.
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource: mcpResource(env.baseURL),
      // The Worker turns the request into `/login?redirect=…` and back (`routes/oauth.ts`).
      loginPage: new URL("/api/oauth/login", env.baseURL).toString(),
      consentPage: new URL("/oauth/consent", env.webAppURL ?? env.baseURL).toString(),
      scopes: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES, STORAGE_SYNC_SCOPE],
      // Desktop sync tokens are for the sync API alone; `/mcp` is added by the plugin. A client
      // is linked only to the resources it was registered with, so an agent never gets this one.
      resources: [
        {
          identifier: storageSyncResource(env.baseURL),
          name: "Omni Desktop sync",
          allowedScopes: [STORAGE_SYNC_SCOPE],
        },
      ],
      // Always on behalf of a person: no `client_credentials`.
      grantTypes: ["authorization_code", "refresh_token"],
      // Strict refresh rotation: a reused refresh token is a stolen one.
      refreshTokenReuseInterval: 0,
      // Clients other than Claude and ChatGPT (MCP Inspector, Cursor, …) still register this way.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: "infer",
      clientRegistrationDefaultScopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        ...MCP_SCOPES,
      ],
      // Every grant names its workspace reach (ADR 0029): one workspace, or all of them.
      postLogin: {
        page: new URL("/oauth/consent", env.webAppURL ?? env.baseURL).toString(),
        shouldRedirect: () => false,
        consentReferenceId: async ({ user, session, scopes }) => {
          const reference = await oauthWorkspaceReference(env.db, {
            sessionId: session.id,
            userId: user.id,
            // Desktop sync has no workspace pick: an agent's earlier one must not narrow it.
            ignorePick: scopes.includes(STORAGE_SYNC_SCOPE),
          });
          if (!reference) {
            throw new APIError("FORBIDDEN", {
              code: "WORKSPACE_NOT_AVAILABLE",
              message: "the chosen workspace is no longer yours",
            });
          }
          return reference;
        },
      },
      // Plural table names, as for every other auth table.
      schema: {
        oauthClient: { modelName: "oauthClients" },
        oauthResource: { modelName: "oauthResources" },
        oauthClientResource: { modelName: "oauthClientResources" },
        oauthRefreshToken: { modelName: "oauthRefreshTokens" },
        oauthAccessToken: { modelName: "oauthAccessTokens" },
        oauthConsent: { modelName: "oauthConsents" },
        oauthClientAssertion: { modelName: "oauthClientAssertions" },
      },
      customAccessTokenClaims: ({ referenceId }) =>
        referenceId && referenceId !== ALL_WORKSPACES ? { [WORKSPACE_CLAIM]: referenceId } : {},
    }),
    cimd({
      metadataProfile: "mcp-2026-07-28",
      // Only allowlisted hosts are ever fetched, so a client id cannot point us at an internal
      // address: a Worker cannot pin the address it resolves (ADR 0029).
      isMetadataDocumentUrlAllowed: (clientIdUrl) => cimdHosts.has(new URL(clientIdUrl).hostname),
      fetchClientMetadataResource: (input, init) => fetch(input, { ...init, redirect: "manual" }),
    }),
  ];
}
