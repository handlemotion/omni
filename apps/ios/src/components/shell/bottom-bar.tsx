import { router } from "expo-router";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAddActions } from "@/components/drive/add-menu.tsx";
import { IconCompose, IconFile, IconFolderPlus, IconImage, IconPlus } from "@/components/icons.ts";
import { BottomFade } from "@/components/ui/bottom-fade.tsx";
import { FloatingCard } from "@/components/ui/floating.tsx";
import { Popover } from "@/components/ui/popover.tsx";
import type { CrmPage } from "@/lib/crm.ts";
import { floatingControl, space } from "@/theme/tokens.ts";
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
};

/**
 * The shell's one bottom bar, over a module and over the menu, the page fading out behind it:
 * the module's search and its main action (New message, Drive's New menu, a new record). Searching or acting from the menu
 * closes it onto the module it shows.
 */
export function BottomBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const closeMenu = useCloseMenu();
  const insets = useSafeAreaInsets();
  const [adding, setAdding] = useState(false);
  const module = shell.isOpen ? shell.browsing : place.module;
  const { setQuery, setSearchIn } = shell;
  const mine = shell.searchIn === module;
  const add = useAddActions({ space: place.drivePage === "shared" ? "shared" : "personal" });
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
    drive: { icon: IconPlus, label: "New", run: () => setAdding(true) },
    crm: {
      icon: IconPlus,
      label: record.label,
      run: () => router.push({ pathname: "/crm/form", params: { kind: record.kind } }),
    },
  }[module];
  const pick = (then: () => void) => {
    setAdding(false);
    then();
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
      <Popover
        isOpen={adding}
        onClose={() => setAdding(false)}
        label="Close New"
        at={{
          right: space(4),
          bottom: Math.max(insets.bottom - space(1), space(4)) + floatingControl + space(2),
        }}
      >
        <FloatingCard>
          <MenuRow icon={IconFolderPlus} label="New folder" onPress={() => pick(add.newFolder)} />
          <MenuRow icon={IconFile} label="Upload file" onPress={() => pick(add.uploadFiles)} />
          <MenuRow
            icon={IconImage}
            label="Upload photo or video"
            onPress={() => pick(add.uploadMedia)}
          />
        </FloatingCard>
      </Popover>
    </>
  );
}
