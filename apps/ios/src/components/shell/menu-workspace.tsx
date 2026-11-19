import type { Workspace } from "@omni/client";
import { router } from "expo-router";
import {
  IconConnections,
  IconLogOut,
  IconPlus,
  IconSettings,
  IconUpgrade,
  IconUserAdd,
  IconUserRound,
} from "@/components/icons.ts";
import { Avatar, AvatarButton } from "@/components/ui/avatar.tsx";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { usePictureSource } from "@/lib/picture.ts";
import { signOut, useSession } from "@/lib/session.ts";
import { openOnWeb, useWorkspaceMenu } from "@/lib/workspace-menu.ts";
import { openWorkspace, useWorkspace, workspaceLabel } from "@/lib/workspace.ts";
import { space } from "@/theme/tokens.ts";
import { ChoiceRow } from "./mailbox-chooser.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { MenuRow, SheetDivider } from "./menu-row.tsx";

const AVATAR = space(11);
const SHEET_LEAD = space(9);

/**
 * The top bar's right button: the workspace's avatar (its logo, else its initial), a circle the
 * size of ☰'s. A tap opens a sheet with the desktop's workspace menu: every workspace you belong
 * to (the current one checked) and New workspace; Account settings, Workspace settings and
 * Connections; a company's Invite members and Upgrade for those who manage it; Log out.
 */
export function WorkspaceButton() {
  const { active, all } = useWorkspace();
  const name = useSession().data?.user.name;
  const sheet = useSheet();
  const place = useMenuPlace();
  const logo = usePictureSource(active?.logo);
  const menu = useWorkspaceMenu(active);
  if (!active) return null;
  const label = workspaceLabel(active, name);
  const { pick } = sheet;
  const switchTo = (id: string) => {
    openWorkspace(id);
    if (place.mailbox) place.openMail({ mailbox: null });
  };
  const settings = (page: "general" | "accounts" | "people" | "billing") =>
    pick(() => openOnWeb({ settings: page, workspace: active }));
  return (
    <>
      <AvatarButton
        name={label}
        size={AVATAR}
        photo={logo}
        inverse
        label={`Workspace, ${label}`}
        onPress={sheet.open}
      />
      <BottomSheet
        isOpen={sheet.isOpen}
        onClose={sheet.close}
        onClosed={sheet.onClosed}
        title="Workspaces"
      >
        {all.map((workspace) => (
          <WorkspaceChoice
            key={workspace.id}
            workspace={workspace}
            name={workspaceLabel(workspace, name)}
            chosen={workspace.id === active.id}
            onPress={() => pick(() => workspace.id === active.id || switchTo(workspace.id))}
          />
        ))}
        {menu.canCreate ? (
          <MenuRow
            leadWidth={SHEET_LEAD}
            icon={IconPlus}
            muted
            label="New workspace"
            onPress={() => pick(() => openOnWeb("onboarding"))}
          />
        ) : null}
        <SheetDivider />
        <MenuRow
          leadWidth={SHEET_LEAD}
          icon={IconUserRound}
          muted
          label="Account settings"
          onPress={() => pick(() => router.push("/settings"))}
        />
        <MenuRow
          leadWidth={SHEET_LEAD}
          icon={IconSettings}
          muted
          label="Workspace settings"
          onPress={() => settings("general")}
        />
        <MenuRow
          leadWidth={SHEET_LEAD}
          icon={IconConnections}
          muted
          label="Connections"
          onPress={() => settings("accounts")}
        />
        {menu.team ? (
          <MenuRow
            leadWidth={SHEET_LEAD}
            icon={IconUserAdd}
            muted
            label="Invite members"
            onPress={() => settings("people")}
          />
        ) : null}
        <SheetDivider />
        {menu.upgrade ? (
          <MenuRow
            icon={IconUpgrade}
            leadWidth={SHEET_LEAD}
            accent
            label="Upgrade"
            onPress={() => settings("billing")}
          />
        ) : null}
        <MenuRow
          leadWidth={SHEET_LEAD}
          icon={IconLogOut}
          muted
          label="Log out"
          onPress={() => pick(() => void signOut())}
        />
      </BottomSheet>
    </>
  );
}

function WorkspaceChoice(props: {
  workspace: Workspace;
  name: string;
  chosen: boolean;
  onPress: () => void;
}) {
  const logo = usePictureSource(props.workspace.logo);
  return (
    <ChoiceRow
      lead={<Avatar name={props.name} size={SHEET_LEAD} photo={logo} inverse />}
      name={props.name}
      detail={props.workspace.kind === "personal" ? "Personal" : "Company"}
      chosen={props.chosen}
      onPress={props.onPress}
    />
  );
}
