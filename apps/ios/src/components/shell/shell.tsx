import { useEffect, useRef } from "react";
import { BottomBar } from "./bottom-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { MenuLayer } from "./menu-layer.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { TopBar } from "./top-bar.tsx";

/**
 * The shell's chrome on a module's root page: the menu, the top bar and the bottom bar. It is
 * drawn inside that page (`ModuleRoot`), so it belongs to the page's native screen: a pushed page
 * or a sheet covers it as it slides in, and it is already there as they slide away. Gating an
 * overlay on the route instead brought it back only once the native back animation had ended.
 */
export function ShellChrome() {
  return (
    <>
      <MenuLayer />
      <TopBar />
      <BottomBar />
    </>
  );
}

/**
 * A search belongs to one module and is cleared when the user lands on another module. It
 * survives opening one of its results, and a search started from the menu for the module it
 * shows survives the move onto that module. Lives in the layout, above every module's page.
 */
export function ClearSearchOnModuleChange() {
  const { setQuery, setSearchIn, searchIn } = useMenu();
  const { module } = useMenuPlace();
  const shown = useRef(module);
  useEffect(() => {
    if (shown.current === module) return;
    shown.current = module;
    if (searchIn === module) return;
    setQuery("");
    setSearchIn(null);
  }, [module, searchIn, setQuery, setSearchIn]);
  return null;
}
