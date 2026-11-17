import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { desktop } from "@/lib/desktop.ts";
import { keys } from "@/lib/query-keys.ts";

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
