import type { StorageSpace } from "@omni/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";

/** Where a node lives: its drive. */
interface Placed {
  orgId: string;
  space: StorageSpace;
  ownerMemberId: string | null;
}

/** Tells each distinct drive among `drives` that it changed, after the response. */
export function announceDrives(c: Context<AppEnv>, drives: (Placed | null | undefined)[]) {
  const distinct = new Map<string, Placed>();
  for (const drive of drives) {
    if (drive) distinct.set(`${drive.orgId}:${drive.space}:${drive.ownerMemberId ?? ""}`, drive);
  }
  for (const { orgId, space, ownerMemberId } of distinct.values()) {
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
    c.executionCtx.waitUntil(
      stub
        .storageChanged(space, ownerMemberId)
        .catch((error: unknown) => c.var.log.warn("storage.announce_failed", { error })),
    );
  }
}
