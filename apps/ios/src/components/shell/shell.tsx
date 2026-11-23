import { useEffect, useRef } from "react";
import { BottomBar } from "./bottom-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { TopBar } from "./top-bar.tsx";

/**
 * The shell's chrome on a module's root page: the top bar and the bottom bar (search + module
 * dock). Drawn inside `ModuleRoot` so it belongs to the page's native screen: a pushed page or
 * sheet covers it as it slides in, and it moves with the page when the left drawer opens.
 */
export function ShellChrome() {
  return (
    <>
      <TopBar />
      <BottomBar />
    </>
  );
}

/**
 * A search belongs to one module and is cleared when the user lands on another module. It
 * survives opening one of its results. Lives in the layout, above every module's page.
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
