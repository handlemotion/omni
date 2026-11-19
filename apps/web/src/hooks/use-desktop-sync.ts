import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { desktop } from "@/lib/desktop.ts";
import { type SyncSetupPhase, syncSetupStep } from "@/lib/desktop-sync-setup.ts";
import { keys } from "@/lib/query-keys.ts";
import { useWorkspaces } from "./use-workspaces.ts";

/** Whether this app can sync at all: the macOS app, for now. */
export const canSyncDrive = desktop.isDesktop && desktop.platform === "mac";

export function useDesktopSync() {
  return useQuery({
    queryKey: keys.desktopSync(),
    queryFn: desktop.sync.status,
    enabled: canSyncDrive,
    refetchOnWindowFocus: true,
  });
}

export function useSetDesktopSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ orgId, on }: { orgId: string; on: boolean }) =>
      on ? desktop.sync.connect(orgId) : desktop.sync.disconnect(orgId),
    onSettled: () => client.invalidateQueries({ queryKey: keys.desktopSync() }),
  });
}

const SETUP_KEY = "omni.desktop-sync-setup";

function readPhase() {
  let phase: SyncSetupPhase = "done";
  try {
    const value = localStorage.getItem(SETUP_KEY);
    phase = value === "signing-in" || value === "done" ? value : "fresh";
  } catch {}
  return phase;
}

function writePhase(phase: SyncSetupPhase) {
  try {
    localStorage.setItem(SETUP_KEY, phase);
  } catch {}
}

/**
 * Sync's first run (ADR 0049): on the Mac app's first launch, every workspace is switched on once,
 * so the Omni folder appears in Finder without a visit to Settings → Drive.
 */
export function useDesktopSyncSetup() {
  const status = useDesktopSync().data;
  const workspaces = useWorkspaces({ enabled: canSyncDrive }).data;
  const client = useQueryClient();
  const running = useRef(false);
  useEffect(() => {
    if (!status || !workspaces || running.current) return;
    const step = syncSetupStep(
      readPhase(),
      status,
      workspaces.workspaces.map((w) => w.id),
    );
    if (step.kind === "wait") return;
    if (step.kind === "finish") return writePhase("done");
    running.current = true;
    writePhase(step.next);
    void (async () => {
      for (const orgId of step.orgIds) await desktop.sync.connect(orgId);
    })()
      .catch((error: unknown) => console.warn("desktop: sync setup failed", error))
      .finally(() => {
        running.current = false;
        void client.invalidateQueries({ queryKey: keys.desktopSync() });
      });
  }, [status, workspaces, client]);
}
