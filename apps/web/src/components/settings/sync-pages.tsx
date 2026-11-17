import { Skeleton, SkeletonBox } from "skullet/react";
import { appToast } from "@/components/ui/toast";
import { canSyncDrive, useDesktopSync, useSetDesktopSync } from "@/hooks/use-desktop-sync.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import { SettingsGroup, SettingsSection, SettingsSections } from "./kit/settings-layout";
import { SettingsToggleRow } from "./kit/settings-toggle-row";
import { WorkspaceAvatar } from "./workspace-pages";

export function DriveSyncPage() {
  const workspaces = useWorkspaces();
  const sync = useDesktopSync();
  const change = useSetDesktopSync();
  if (!canSyncDrive) return null;
  const state = (orgId: string) =>
    sync.data?.workspaces.find((w) => w.orgId === orgId)?.state ?? "off";
  return (
    <SettingsSections>
      <SettingsSection title="This computer">
        {!workspaces.data || !sync.data ? (
          <Skeleton
            loading
            label="Loading Drive sync"
            skeleton={<SkeletonBox width="100%" height={64} radius="var(--radius-xl)" />}
          >
            {null}
          </Skeleton>
        ) : (
          <SettingsGroup>
            {workspaces.data.workspaces.map((workspace) => (
              <SettingsToggleRow
                key={workspace.id}
                id={`sync-${workspace.id}`}
                label={workspace.name}
                avatar={<WorkspaceAvatar workspace={workspace} size={32} />}
                checked={state(workspace.id) !== "off"}
                disabled={!sync.data.available || change.isPending}
                onCheckedChange={(on) =>
                  change.mutate(
                    { orgId: workspace.id, on },
                    { onError: () => appToast.error("Drive sync could not be changed.") },
                  )
                }
              />
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>
    </SettingsSections>
  );
}
