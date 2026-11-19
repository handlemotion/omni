import type { DesktopSyncStatus } from "@omni/client";

/**
 * Drive sync's first run on a Mac (ADR 0049): the app turns sync on for every workspace once,
 * so the Omni folder appears without a trip to Settings → Drive.
 *
 * `fresh`: never run on this computer. `signing-in`: the first workspace was switched on, which
 * sends the window to the sync sign-in when there is no grant yet; on return the rest follow.
 * `done`: never again, so a workspace switched off stays off.
 */
export type SyncSetupPhase = "fresh" | "signing-in" | "done";

export type SyncSetupStep =
  | { kind: "connect"; orgIds: string[]; next: SyncSetupPhase }
  | { kind: "finish" }
  | { kind: "wait" };

/**
 * What to do now. A computer already set up (by hand or before) is left alone, and a sign-in
 * that came back without a grant (cancelled, refused) ends setup instead of asking again.
 */
export function syncSetupStep(
  phase: SyncSetupPhase,
  status: DesktopSyncStatus,
  workspaceIds: string[],
) {
  const on = new Set(status.workspaces.filter((w) => w.state !== "off").map((w) => w.orgId));
  const off = workspaceIds.filter((id) => !on.has(id));
  const signedIn = on.size > 0 && status.workspaces.every((w) => w.state !== "needs_attention");
  let step: SyncSetupStep = { kind: "finish" };
  if (phase === "done" || !status.available) step = { kind: "wait" };
  else if (off.length === 0) step = { kind: "finish" };
  else if (phase === "fresh" && on.size === 0)
    step = { kind: "connect", orgIds: off.slice(0, 1), next: "signing-in" };
  else if (phase === "signing-in" && signedIn)
    step = { kind: "connect", orgIds: off, next: "done" };
  return step;
}
