import { router } from "expo-router";
import { useAddActions } from "@/components/drive/add-menu.tsx";
import { IconCompose, IconFile, IconFolderPlus, IconImage, IconPlus } from "@/components/icons.ts";
import { BottomFade } from "@/components/ui/bottom-fade.tsx";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import type { CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES } from "@/lib/drive.ts";
import { FloatingBar, type FloatingBarAction } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace, type Module } from "./menu-nav.ts";
import { MenuRow } from "./menu-row.tsx";
import { ModuleDock } from "./module-dock.tsx";

const PLACEHOLDER: Partial<Record<Module, string>> = {
  mail: "Search mail",
  drive: "Search files",
  crm: "Search records",
};

const NEW_RECORD: Record<CrmPage, { kind: string; label: string }> = {
  companies: { kind: "company", label: "New company" },
  people: { kind: "person", label: "New person" },
  deals: { kind: "deal", label: "New deal" },
  projects: { kind: "deal", label: "New deal" },
  tasks: { kind: "task", label: "New task" },
};

/**
 * The shell's bottom bar on a module's root page, the page fading out behind it: the module's
 * search bar and main action (New message, Drive's Add sheet, a new record) stacked above the
 * bottom module switcher dock. Calendar shows only the dock until calendar features land.
 */
export function BottomBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const adding = useSheet();
  const module = place.module;
  const { close, setQuery, setSearchIn } = shell;
  const mine = shell.searchIn === module;
  const shared = place.drivePage === "shared";
  const add = useAddActions({ space: shared ? "shared" : "personal" });
  const record = NEW_RECORD[place.crmPage ?? "companies"];

  const actions: Partial<Record<Module, FloatingBarAction>> = {
    mail: {
      icon: IconCompose,
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
      label: "New",
      onPress: () => {
        close();
        adding.open();
      },
    },
    crm: {
      icon: IconPlus,
      label: record.label,
      onPress: () => {
        close();
        if (record.kind === "task") router.push("/crm/task-new");
        else router.push({ pathname: "/crm/form", params: { kind: record.kind } });
      },
    },
  };

  return (
    <>
      <BottomFade />
      <FloatingBar
        key={module}
        placeholder={PLACEHOLDER[module]}
        initial={{ searching: mine, query: mine ? shell.query : "" }}
        query={mine ? shell.query : undefined}
        onSearch={setQuery}
        onStart={() => {
          close();
          setQuery("");
          setSearchIn(module);
        }}
        onStop={() => setSearchIn(null)}
        action={actions[module]}
        dock={<ModuleDock />}
      />
      <BottomSheet
        isOpen={adding.isOpen}
        onClose={adding.close}
        onClosed={adding.onClosed}
        title={`Add to ${DRIVE_PAGES[shared ? "shared" : "my"].label}`}
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
}
