import { router } from "expo-router";
import { useAddActions } from "@/components/drive/add-menu.tsx";
import {
  IconCompose,
  IconFile,
  IconFolderPlus,
  IconImage,
  IconPlus,
  IconSearch,
} from "@/components/icons.ts";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { FloatingButton } from "@/components/ui/floating.tsx";
import type { CrmPage } from "@/lib/crm.ts";
import type { DrivePlace } from "@/lib/drive-actions.ts";
import { DRIVE_PAGES, useTeamspaces } from "@/lib/drive.ts";
import { iconSize } from "@/theme/tokens.ts";
import { SEARCH_PLACEHOLDER } from "./bottom-bar.tsx";
import type { FloatingBarAction } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace, type Module } from "./menu-nav.ts";
import { MenuRow } from "./menu-row.tsx";

const NEW_RECORD: Record<CrmPage, { kind: string; label: string }> = {
  companies: { kind: "company", label: "New company" },
  people: { kind: "person", label: "New person" },
  deals: { kind: "deal", label: "New deal" },
  projects: { kind: "deal", label: "New deal" },
  tasks: { kind: "task", label: "New task" },
};

type ModuleAction = FloatingBarAction & { title: string; glyphSize: number };

function useModuleAction() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const adding = useSheet();
  const teamspaces = (useTeamspaces().data ?? []).filter((one) => one.role !== null);
  const activeSpace = place.driveSpace
    ? teamspaces.find((one) => one.id === place.driveSpace)
    : undefined;
  const fallbackSpace = !activeSpace && place.drivePage === "recents" ? teamspaces[0] : undefined;
  const shared = place.drivePage === "shared";
  const targetSpace = activeSpace ?? fallbackSpace;
  const addPlace: DrivePlace = targetSpace
    ? { teamspaceId: targetSpace.id }
    : { space: shared ? "shared" : "personal" };
  const addLabel = targetSpace ? targetSpace.name : DRIVE_PAGES[shared ? "shared" : "my"].label;
  const add = useAddActions(addPlace);
  const record = NEW_RECORD[place.crmPage ?? "companies"];

  const actions: Partial<Record<Module, ModuleAction>> = {
    mail: {
      icon: IconCompose,
      glyphSize: 16,
      title: "Compose",
      label: "New message",
      onPress: () => {
        close();
        router.push({
          pathname: "/mail/compose",
          params: place.mailbox ? { mailbox: place.mailbox } : {},
        });
      },
    },
    drive: {
      icon: IconPlus,
      glyphSize: iconSize.md,
      title: "Add",
      label: "Add",
      onPress: () => {
        close();
        adding.open();
      },
    },
    crm: {
      icon: IconPlus,
      glyphSize: iconSize.md,
      title: "New",
      label: record.label,
      onPress: () => {
        close();
        if (record.kind === "task") router.push("/crm/task-new");
        else router.push({ pathname: "/crm/form", params: { kind: record.kind } });
      },
    },
  };

  const sheet = (
    <>
      <BottomSheet
        isOpen={adding.isOpen}
        onClose={adding.close}
        onClosed={adding.onClosed}
        title={`Add to ${addLabel}`}
      >
        <MenuRow
          icon={IconFolderPlus}
          muted
          label="New folder"
          onPress={() => adding.pick(add.newFolder)}
        />
        <MenuRow
          icon={IconImage}
          muted
          label="Photos and videos"
          onPress={() => adding.pick(add.uploadMedia)}
        />
        <MenuRow
          icon={IconFile}
          muted
          label="Choose file"
          onPress={() => adding.pick(add.uploadFiles)}
        />
      </BottomSheet>
    </>
  );
  const action: ModuleAction | undefined = actions[place.module];
  return { action, sheet };
}

/** The module's search as a round grey button beside its main action; none where it has no search. */
export function ModuleSearch() {
  const place = useMenuPlace();
  const { close, setQuery, setSearchIn } = useMenu();
  const label = SEARCH_PLACEHOLDER[place.module];
  if (!label) return null;
  return (
    <FloatingButton
      icon={IconSearch}
      label={label}
      glyph={iconSize.md}
      onPress={() => {
        close();
        setQuery("");
        setSearchIn(place.module);
      }}
    />
  );
}

/** The module's main action (New message, New file…) as a round brand button on the page. */
export function ModuleMainAction() {
  const { action, sheet } = useModuleAction();
  if (!action) return null;
  return (
    <>
      <FloatingButton
        primary
        icon={action.icon}
        label={action.label}
        glyph={iconSize.md}
        onPress={action.onPress}
      />
      {sheet}
    </>
  );
}
