// Storage sync for the desktop app (ADR 0043, docs/spec/desktop.md "The sync protocol"), under
// `/api/storage/sync`. A desktop sync provider calls it with an OAuth access token from the
// first-party Omni Desktop client, bound to this API and holding `storage:sync`; it never sees a
// session cookie. One token spans every workspace the person belongs to (or the one company a
// scoped session granted), so every route but `drives` names its workspace and acts as the
// person's member there, checked on each request. The routes the app already has (list, folders,
// rename, move, trash, uploads, download, usage) are mounted again under `/:orgId`.
import {
  DESKTOP_CLIENT_ID,
  DESKTOP_REDIRECT_URI,
  STORAGE_SYNC_SCOPE,
  storageSyncResource,
  WORKSPACE_CLAIM,
} from "@omni/auth";
import {
  storageSyncChangesQuerySchema,
  type StorageNodeResponse,
  type StorageSyncChangesResponse,
  type StorageSyncDrivesResponse,
} from "@omni/contracts";
import { ensureFirstPartyOAuthClient, forUser, type StorageChangesResult } from "@omni/db";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { requireWritableWorkspace } from "../billing.ts";
import { findMember, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { verifyAccessToken } from "../mcp/auth.ts";
import { checkRateLimit, tooManyRequests } from "../rate-limiter.ts";
import { storageChanges } from "./changes.ts";
import { wireNode } from "./core.ts";
import { decodeCursor, encodeCursor, memberStorage, refused } from "./http.ts";
import { storageReads } from "./routes.ts";
import { zValidator } from "../validator.ts";

/** Who a sync token acts for. */
export interface SyncCaller {
  userId: string;
  clientId: string;
  /** The one workspace the grant reaches, or null for every workspace the person is in. */
  workspace: string | null;
}

const syncCursor = z.object({ revision: z.number().int(), id: z.string() });

/** The desktop app's PKCE challenge (S256, RFC 7636) and its state. */
const authorizeQuery = z.object({
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.string().min(1).max(512),
});

/** 401 `unauthorized`, with the challenge a client reads to start sign-in again. */
function unauthorized(c: Context<AppEnv>, description: string) {
  c.header("www-authenticate", `Bearer error="invalid_token", scope="${STORAGE_SYNC_SCOPE}"`);
  return apiError(c, "unauthorized", description);
}

/** The bearer token's caller, or 401: a token our provider signed for this API, with the scope. */
const requireSyncToken = createMiddleware<AppEnv>(async (c, next) => {
  const token = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (!token) return unauthorized(c, "sign in to Omni first");
  const { auth, db, config } = c.var;
  const payload = await verifyAccessToken(
    token,
    auth,
    db,
    storageSyncResource(config.auth.baseURL),
  );
  if (!payload?.sub) return unauthorized(c, "the access token is invalid or expired");
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  if (!scopes.includes(STORAGE_SYNC_SCOPE)) {
    c.header(
      "www-authenticate",
      `Bearer error="insufficient_scope", scope="${STORAGE_SYNC_SCOPE}"`,
    );
    return apiError(c, "forbidden", `this needs the ${STORAGE_SYNC_SCOPE} permission`);
  }
  const workspace = payload[WORKSPACE_CLAIM];
  const caller: SyncCaller = {
    userId: payload.sub,
    clientId: String(payload.azp ?? payload.client_id ?? ""),
    workspace: typeof workspace === "string" ? workspace : null,
  };
  const wait = await checkRateLimit(
    c.env,
    config,
    "storageSync",
    `${caller.userId}:${caller.clientId}`,
  );
  if (wait) return tooManyRequests(c, wait, "storageSync");
  c.set("syncCaller", caller);
  await next();
});

/**
 * The person's member in the workspace the path names, as `member`, so the shared routes act
 * as it. 404 when they are not in it, or their grant does not reach it.
 */
const requireSyncMember = createMiddleware<AppEnv>(async (c, next) => {
  const caller = c.var.syncCaller!;
  const orgId = c.req.param("orgId");
  const member = orgId ? await findMember(c.var.db, caller.userId, orgId, caller.workspace) : null;
  if (!member || member.orgId !== orgId) return refused(c, "not_found");
  c.set("member", member);
  c.set("log", c.var.log.child({ component: "storage-sync", orgId }));
  await next();
});

function wireChanges(result: Extract<StorageChangesResult, { status: "ok" }>) {
  return {
    changes: result.changes.map((change) =>
      change.deleted
        ? { id: change.id, revision: change.revision, node: null, inTrash: false }
        : {
            id: change.id,
            revision: change.revision,
            node: wireNode(change.node),
            inTrash: change.inTrash,
          },
    ),
    nextCursor: encodeCursor(result.nextCursor)!,
    more: result.more,
  } satisfies StorageSyncChangesResponse;
}

export const storageSync = new Hono<AppEnv>()
  /**
   * Where the desktop app starts signing in: the first-party client is made sure of, then the
   * browser goes on to the provider's authorize endpoint with that client, its redirect and this
   * API as the resource. The app sends its PKCE challenge and state; nothing else is taken.
   */
  .get("/authorize", zValidator("query", authorizeQuery), async (c) => {
    const { config, db } = c.var;
    const query = c.req.valid("query");
    const resource = storageSyncResource(config.auth.baseURL);
    await ensureFirstPartyOAuthClient(db, {
      clientId: DESKTOP_CLIENT_ID,
      name: "Omni Desktop",
      redirectUri: DESKTOP_REDIRECT_URI,
      scopes: ["offline_access", STORAGE_SYNC_SCOPE],
      resource: {
        identifier: resource,
        name: "Omni Desktop sync",
        allowedScopes: [STORAGE_SYNC_SCOPE],
      },
    });
    const url = new URL("/api/auth/oauth2/authorize", config.auth.baseURL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: DESKTOP_CLIENT_ID,
      redirect_uri: DESKTOP_REDIRECT_URI,
      scope: `offline_access ${STORAGE_SYNC_SCOPE}`,
      resource,
      code_challenge: query.code_challenge,
      code_challenge_method: "S256",
      state: query.state,
    }).toString();
    return c.redirect(url.toString(), 302);
  })

  .use(requireSyncToken)

  /** Every workspace the person can sync, with its drives and their revisions now. */
  .get("/drives", async (c) => {
    const caller = c.var.syncCaller!;
    const workspaces = await forUser(
      c.var.db,
      caller.userId,
      caller.workspace,
    ).storage.syncWorkspaces();
    return c.json({
      workspaces: workspaces.map(({ orgId, name, drives }) => ({ orgId, name, drives })),
    } satisfies StorageSyncDrivesResponse);
  })

  .use("/:orgId/*", requireSyncMember)
  .use("/:orgId/*", requireWritableWorkspace)

  /** A drive's changes after `cursor`, in revision order. No cursor: the whole drive, paged. */
  .get("/:orgId/changes", zValidator("query", storageSyncChangesQuerySchema), async (c) => {
    const { space, cursor, limit } = c.req.valid("query");
    const result = await memberStorage(c).changes(space, {
      cursor: decodeCursor(cursor, syncCursor),
      limit,
    });
    if (result.status === "cursor_expired") {
      return apiError(c, "cursor_expired", "list the drive again without a cursor");
    }
    if (result.status !== "ok") return refused(c, result.status);
    return c.json(wireChanges(result));
  })

  /** One node the member reaches, for the provider's item lookup. In Trash: `404`. */
  .get("/:orgId/nodes/:id{[^/]+}", async (c) => {
    const view = await memberStorage(c).node(c.req.param("id"));
    if (!view || view.inTrash) return refused(c, "not_found");
    return c.json({ node: wireNode(view.node) } satisfies StorageNodeResponse);
  })

  .route("/:orgId", storageReads)
  .route("/:orgId", storageChanges);
