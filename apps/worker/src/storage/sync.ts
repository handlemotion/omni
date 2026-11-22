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
import { findMember, type AppEnv, type SyncCaller } from "../context.ts";
import { apiError } from "../errors.ts";
import { verifyAccessToken } from "../mcp/auth.ts";
import { checkRateLimit, tooManyRequests } from "../rate-limiter.ts";
import { MEMBER_HEADER, SYNC_HEADER } from "../realtime.ts";
import { OUTSIDE_HEADER } from "../realtime-outside.ts";
import { storageChanges } from "./changes.ts";
import { wireNode } from "./core.ts";
import { decodeCursor, encodeCursor, memberStorage, refused } from "./http.ts";
import { storageReads } from "./routes.ts";
import { zValidator } from "../validator.ts";

const syncCursor = z.object({ revision: z.number().int(), id: z.string() });

const authorizeQuery = z.object({
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.string().min(1).max(512),
});

function unauthorized(c: Context<AppEnv>, description: string) {
  c.header("www-authenticate", `Bearer error="invalid_token", scope="${STORAGE_SYNC_SCOPE}"`);
  return apiError(c, "unauthorized", description);
}

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
        ? {
            id: change.id,
            revision: change.revision,
            node: null,
            inTrash: false,
            gone: change.gone,
          }
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

  .get("/:orgId/nodes/:id{[^/]+}", async (c) => {
    const view = await memberStorage(c).node(c.req.param("id"));
    if (!view || view.inTrash) return refused(c, "not_found");
    return c.json({ node: wireNode(view.node) } satisfies StorageNodeResponse);
  })

  .get("/:orgId/realtime", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return apiError(c, "upgrade_required", "expected a websocket upgrade");
    }
    const { id, orgId } = c.var.member;
    const headers = new Headers(c.req.raw.headers);
    headers.delete(OUTSIDE_HEADER);
    headers.set(MEMBER_HEADER, id);
    headers.set(SYNC_HEADER, "1");
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })

  .route("/:orgId", storageReads)
  .route("/:orgId", storageChanges);
