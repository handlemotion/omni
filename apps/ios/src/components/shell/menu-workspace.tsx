import { router } from "expo-router";
import { useState } from "react";
import { IconCheck, IconLogOut, IconSettings } from "@/components/icons.ts";
import { Avatar, AvatarButton } from "@/components/ui/avatar.tsx";
import { FloatingCard } from "@/components/ui/floating.tsx";
import { Popover } from "@/components/ui/popover.tsx";
import { usePictureSource } from "@/lib/picture.ts";
import { signOut, useSession } from "@/lib/session.ts";
import { openWorkspace, useWorkspace, workspaceLabel } from "@/lib/workspace.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { MenuRow } from "./menu-row.tsx";

const AVATAR = space(11);
const SMALL = iconSize.menu;

/**
 * The top bar's right button: the workspace's avatar (its logo, else its initial), a circle
 * the size of ☰'s. A tap opens
 * a small menu under it: every workspace you belong to (the current one checked), Settings and
 * Log out.
 */
export function WorkspaceButton({ top, right }: { top: number; right: number }) {
  const { active, all } = useWorkspace();
  const name = useSession().data?.user.name;
  const [open, setOpen] = useState(false);
  const logo = usePictureSource(active?.logo);
  if (!active) return null;
  const label = workspaceLabel(active, name);
  const pick = (then: () => void) => {
    setOpen(false);
    then();
  };
  return (
    <>
      <AvatarButton
        name={label}
        size={AVATAR}
        photo={logo}
        inverse
        label={`Workspace, ${label}`}
        onPress={() => setOpen(true)}
      />
      <Popover
        isOpen={open}
        onClose={() => setOpen(false)}
        label="Close workspaces"
        at={{ top, right }}
      >
        <FloatingCard>
          {all.map((workspace) => {
            const current = workspace.id === active.id;
            const title = workspaceLabel(workspace, name);
            return (
              <MenuRow
                key={workspace.id}
                lead={<Avatar name={title} size={SMALL} inverse />}
                label={title}
                trailing={
                  current ? <IconCheck size={iconSize.sm} color={colors.primary} /> : undefined
                }
                onPress={() => pick(() => current || openWorkspace(workspace.id))}
              />
            );
          })}
          <MenuRow
            icon={IconSettings}
            label="Settings"
            onPress={() => pick(() => router.push("/settings"))}
          />
          <MenuRow icon={IconLogOut} label="Log out" onPress={() => pick(() => void signOut())} />
        </FloatingCard>
      </Popover>
    </>
  );
}
