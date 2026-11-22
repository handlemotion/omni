import {
  storageCreateTeamspaceBodySchema,
  storagePutTeamspaceMemberBodySchema,
  storageUpdateTeamspaceBodySchema,
  type StorageTeamspace as WireTeamspace,
  type StorageTeamspaceMembersResponse,
  type StorageTeamspaceResponse,
  type StorageTeamspacesResponse,
} from "@omni/contracts";
import type { StorageTeamspace } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announceTeamspaces } from "./announce.ts";
import { deleteStorageObjects } from "./core.ts";
import { memberStorage, refused } from "./http.ts";

const wireTeamspace = (teamspace: StorageTeamspace) =>
  ({ ...teamspace, createdAt: teamspace.createdAt.toISOString() }) satisfies WireTeamspace;

/** A workspace's teamspaces (`docs/spec/teamspaces.md`): list, make, manage, and who is in them. */
export const storageTeamspaces = new Hono<AppEnv>()
  .get("/teamspaces", async (c) => {
    const teamspaces = await memberStorage(c).teamspaces();
    return c.json({
      teamspaces: teamspaces.map(wireTeamspace),
    } satisfies StorageTeamspacesResponse);
  })

  .post("/teamspaces", zValidator("json", storageCreateTeamspaceBodySchema), async (c) => {
    const made = await memberStorage(c).createTeamspace(c.req.valid("json"));
    if (made.status !== "ok") return refused(c, made.status);
    announceTeamspaces(c);
    return c.json(
      { teamspace: wireTeamspace(made.teamspace) } satisfies StorageTeamspaceResponse,
      201,
    );
  })

  .get("/teamspaces/:id", async (c) => {
    const found = await memberStorage(c).teamspace(c.req.param("id"));
    if (!found) return refused(c, "not_found");
    return c.json({ teamspace: wireTeamspace(found) } satisfies StorageTeamspaceResponse);
  })

  .patch("/teamspaces/:id", zValidator("json", storageUpdateTeamspaceBodySchema), async (c) => {
    const changed = await memberStorage(c).updateTeamspace(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed.status);
    announceTeamspaces(c);
    return c.json({
      teamspace: wireTeamspace(changed.teamspace),
    } satisfies StorageTeamspaceResponse);
  })

  .delete("/teamspaces/:id", async (c) => {
    const deleted = await memberStorage(c).deleteTeamspace(c.req.param("id"));
    if (deleted.status !== "ok") return refused(c, deleted.status);
    announceTeamspaces(c);
    await deleteStorageObjects(c.env.STORAGE_BUCKET, deleted.r2Keys, c.var.log);
    return c.body(null, 204);
  })

  .get("/teamspaces/:id/members", async (c) => {
    const listed = await memberStorage(c).teamspaceMembers(c.req.param("id"));
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({ members: listed.members } satisfies StorageTeamspaceMembersResponse);
  })

  .post("/teamspaces/:id/join", async (c) => {
    const joined = await memberStorage(c).joinTeamspace(c.req.param("id"));
    if (joined.status !== "ok") return refused(c, joined.status);
    announceTeamspaces(c);
    return c.json({ members: joined.members } satisfies StorageTeamspaceMembersResponse);
  })

  .put(
    "/teamspaces/:id/members/:memberId",
    zValidator("json", storagePutTeamspaceMemberBodySchema),
    async (c) => {
      const put = await memberStorage(c).putTeamspaceMember(
        c.req.param("id"),
        c.req.param("memberId"),
        c.req.valid("json").role,
      );
      if (put.status !== "ok") return refused(c, put.status);
      announceTeamspaces(c);
      return c.json({ members: put.members } satisfies StorageTeamspaceMembersResponse);
    },
  )

  .delete("/teamspaces/:id/members/:memberId", async (c) => {
    const removed = await memberStorage(c).removeTeamspaceMember(
      c.req.param("id"),
      c.req.param("memberId"),
    );
    if (removed.status !== "ok") return refused(c, removed.status);
    announceTeamspaces(c);
    return c.json({ members: removed.members } satisfies StorageTeamspaceMembersResponse);
  });
