import { router } from "expo-router";
import { useAddActions } from "@/components/drive/add-menu.tsx";
import { IconCompose, IconFile, IconFolderPlus, IconImage, IconPlus } from "@/components/icons.ts";
import { BottomFade } from "@/components/ui/bottom-fade.tsx";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import type { CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES } from "@/lib/drive.ts";
import { FloatingBar } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useCloseMenu, useMenuPlace, type Module } from "./menu-nav.ts";
import { MenuRow } from "./menu-row.tsx";

const PLACEHOLDER: Record<Module, string> = {
  mail: "Search mail",
  drive: "Search files",
  crm: "Search records",
};

const NEW_RECORD: Record<CrmPage, { kind: string; label: string }> = {
  companies: { kind: "company", label: "New company" },
  people: { kind: "person", label: "New person" },
  deals: { kind: "deal", label: "New deal" },
  projects: { kind: "deal", label: "New deal" },
};

/**
 * The shell's one bottom bar, over a module and over the menu, the page fading out behind it:
 * the module's search and its main action (New message, Drive's Add sheet, a new record). Searching or acting from the menu
 * closes it onto the module it shows.
 */
export function BottomBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const closeMenu = useCloseMenu();
  const adding = useSheet();
  const module = shell.isOpen ? shell.browsing : place.module;
  const { setQuery, setSearchIn } = shell;
  const mine = shell.searchIn === module;
  const shared = place.drivePage === "shared";
  const add = useAddActions({ space: shared ? "shared" : "personal" });
  const record = NEW_RECORD[place.crmPage ?? "companies"];
  const act = {
    mail: {
      icon: IconCompose,
      label: "New message",
      run: () =>
        router.push({
          pathname: "/mail/compose",
          params: place.mailbox ? { mailbox: place.mailbox } : {},
        }),
    },
    drive: { icon: IconPlus, label: "New", run: adding.open },
    crm: {
      icon: IconPlus,
      label: record.label,
      run: () => router.push({ pathname: "/crm/form", params: { kind: record.kind } }),
    },
  }[module];
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
          closeMenu();
          setQuery("");
          setSearchIn(module);
        }}
        onStop={() => setSearchIn(null)}
        action={{
          icon: act.icon,
          label: act.label,
          onPress: () => {
            closeMenu();
            act.run();
          },
        }}
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
