import type { StorageNodeSpace } from "@omni/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import type { Logger } from "../log.ts";

/** Where a node lives: its drive. */
interface Placed {
  orgId: string;
  space: StorageNodeSpace;
  ownerMemberId: string | null;
  teamspaceId?: string | null;
}

/**
 * What a change touched: a node (its folder's listing changed, and a folder's own), a place it
 * left (`parentId`), or only a drive (nothing any folder lists, such as Trash).
 */
export type Touched = Placed & {
  parentId?: string | null;
  id?: string;
  kind?: "file" | "folder";
};

const listingsOf = (touched: Touched) => [
  ...(touched.parentId === undefined ? [] : [touched.parentId]),
  ...(touched.kind === "folder" && touched.id ? [touched.id] : []),
];

/**
 * Tells each distinct drive among `touched` that it changed, after the response, naming the
 * folders whose listing changed so open apps refetch only those.
 */
export function announceDrives(c: Context<AppEnv>, touched: (Touched | null | undefined)[]) {
  announceTo(
    { env: c.env, waitUntil: (work) => c.executionCtx.waitUntil(work), log: c.var.log },
    touched,
  );
}

/** `announceDrives` away from a request's context: from a tool, a job or a queue. */
export function announceTo(
  at: { env: Env; waitUntil: (work: Promise<unknown>) => void; log: Logger },
  touched: (Touched | null | undefined)[],
) {
  const drives = new Map<string, Placed & { parentIds: Set<string | null> }>();
  for (const one of touched) {
    if (!one) continue;
    const key = `${one.orgId}:${one.space}:${one.ownerMemberId ?? ""}:${one.teamspaceId ?? ""}`;
    const drive = drives.get(key) ?? { ...one, parentIds: new Set<string | null>() };
    for (const parentId of listingsOf(one)) drive.parentIds.add(parentId);
    drives.set(key, drive);
  }
  for (const { orgId, space, ownerMemberId, teamspaceId, parentIds } of drives.values()) {
    const stub = at.env.REALTIME.get(at.env.REALTIME.idFromName(orgId));
    at.waitUntil(
      stub
        .storageChanged(space, ownerMemberId, [...parentIds], teamspaceId ?? null)
        .catch((error: unknown) => at.log.warn("storage.announce_failed", { error })),
    );
  }
}
