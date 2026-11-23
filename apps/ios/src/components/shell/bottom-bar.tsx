import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarFade } from "@/components/ui/edge-blur.tsx";
import { floatingControl, space } from "@/theme/tokens.ts";
import { FloatingBar, SEARCH_DOCK_GAP } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace, type Module } from "./menu-nav.ts";
import { DOCK_HEIGHT, ModuleDock } from "./module-dock.tsx";

const PLACEHOLDER: Partial<Record<Module, string>> = {
  mail: "Search mail",
  drive: "Search files",
  crm: "Search records",
};

/**
 * The shell's bottom bar on a module's root page: the current module's search bar stacked above
 * the module dock. The page blurs and fades out before it reaches the search bar, so nothing
 * scrolls visibly behind the dock. Calendar shows only the dock until it has a search.
 */
export function BottomBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const insets = useSafeAreaInsets();
  const module = place.module;
  const { close, setQuery, setSearchIn } = shell;
  const mine = shell.searchIn === module;
  const placeholder = PLACEHOLDER[module];
  const bottom = Math.max(insets.bottom - space(1), space(3));
  const chrome = bottom + DOCK_HEIGHT + (placeholder ? SEARCH_DOCK_GAP + floatingControl : 0);
  return (
    <>
      <BarFade middle={chrome - floatingControl / 2} />
      <FloatingBar
        key={module}
        placeholder={placeholder}
        initial={{ searching: mine, query: mine ? shell.query : "" }}
        query={mine ? shell.query : undefined}
        onSearch={setQuery}
        onStart={() => {
          close();
          setQuery("");
          setSearchIn(module);
        }}
        onStop={() => setSearchIn(null)}
        dock={<ModuleDock />}
      />
    </>
  );
}
