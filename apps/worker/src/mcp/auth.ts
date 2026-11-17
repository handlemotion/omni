import { MAIL_READ_SCOPE, mcpResource, WORKSPACE_CLAIM, type Auth } from "@omni/auth";
import { tokenSigningKeys, type Db } from "@omni/db";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";

export interface McpCaller {
  userId: string;
  /** The one workspace the grant reaches, or null for every workspace the user belongs to. */
  workspace: string | null;
  scopes: Set<string>;
  clientId: string;
  token: string;
  expiresAt: number;
}

const JWKS_TTL_MS = 5 * 60_000;
let jwksCache: { keys: JSONWebKeySet; issuer: string; expires: number } | undefined;

async function verificationKeys(auth: Auth, db: Db, forceRefresh: boolean) {
  if (!forceRefresh && jwksCache && jwksCache.expires > Date.now()) return jwksCache;
  const [keys, context] = await Promise.all([tokenSigningKeys(db), auth.$context]);
  jwksCache = {
    keys: { keys } as JSONWebKeySet,
    issuer: context.baseURL,
    expires: Date.now() + JWKS_TTL_MS,
  };
  return jwksCache;
}

/** The metadata document clients read to find our authorization server. */
export function resourceMetadataUrl(baseURL: string) {
  return new URL("/.well-known/oauth-protected-resource/mcp", baseURL).toString();
}

function challenge(
  status: 401 | 403,
  baseURL: string,
  scopes: readonly string[],
  error?: { code: string; description: string },
) {
  const params = [
    ...(error ? [`error="${error.code}"`, `error_description="${error.description}"`] : []),
    `resource_metadata="${resourceMetadataUrl(baseURL)}"`,
    `scope="${scopes.join(" ")}"`,
  ];
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: error?.description ?? "sign in to Omni first" },
      id: null,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer ${params.join(", ")}`,
      },
    },
  );
}

/** 403 asking the client to step up to every scope in `needed`. */
export function insufficientScope(baseURL: string, needed: readonly string[]) {
  return challenge(403, baseURL, needed, {
    code: "insufficient_scope",
    description: `this needs the ${needed.join(", ")} permission`,
  });
}

/**
 * The claims of an access token our provider signed for `audience`, or null when its signature,
 * issuer, audience or expiry does not hold. Shared by `/mcp` and the desktop sync API.
 */
export async function verifyAccessToken(token: string, auth: Auth, db: Db, audience: string) {
  const verify = async (forceRefresh: boolean) => {
    const { keys, issuer } = await verificationKeys(auth, db, forceRefresh);
    return jwtVerify(token, createLocalJWKSet(keys), { issuer, audience });
  };
  try {
    return (await verify(false)).payload;
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey)) return null;
    try {
      return (await verify(true)).payload;
    } catch {
      return null;
    }
  }
}

/**
 * The caller, or the response to send instead: 401 without a valid token for this resource, 403
 * when it lacks `mail:read` (every tool reads).
 */
export const authenticate: (
  request: Request,
  auth: Auth,
  db: Db,
  baseURL: string,
) => Promise<McpCaller | Response> = async (request, auth, db, baseURL) => {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer (\S+)$/i.exec(header)?.[1];
  if (!token) return challenge(401, baseURL, [MAIL_READ_SCOPE]);

  const payload = await verifyAccessToken(token, auth, db, mcpResource(baseURL));
  if (!payload?.sub) {
    return challenge(401, baseURL, [MAIL_READ_SCOPE], {
      code: "invalid_token",
      description: "the access token is invalid or expired",
    });
  }

  const scopes = new Set(typeof payload.scope === "string" ? payload.scope.split(" ") : []);
  if (!scopes.has(MAIL_READ_SCOPE)) return insufficientScope(baseURL, [MAIL_READ_SCOPE]);
  const workspace = payload[WORKSPACE_CLAIM];
  return {
    userId: payload.sub,
    workspace: typeof workspace === "string" ? workspace : null,
    scopes,
    clientId: String(payload.azp ?? payload.client_id ?? ""),
    token,
    expiresAt: payload.exp ?? 0,
  };
};
