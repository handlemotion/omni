import { useEffect, useRef } from "react";
import { BottomBar } from "./bottom-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { MenuLayer } from "./menu-layer.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { TopBar } from "./top-bar.tsx";

/**
 * The shell's chrome over every root page: the menu, the top bar and the bottom bar. A pushed
 * page brings its own header, so the chrome steps away unless the menu is open.
 *
 * A search belongs to one module and is cleared here when the user lands on another module. It
 * survives opening one of its results (the bottom bar unmounts on a pushed page), and a search
 * started from the menu for the module it shows survives the move onto that module.
 */
export function ShellChrome() {
  const shell = useMenu();
  const { onRoot, module } = useMenuPlace();
  const { setQuery, setSearchIn, searchIn } = shell;
  const shown = useRef(module);
  useEffect(() => {
    if (shown.current === module) return;
    shown.current = module;
    if (searchIn === module) return;
    setQuery("");
    setSearchIn(null);
  }, [module, searchIn, setQuery, setSearchIn]);
  if (!onRoot && !shell.isOpen) return null;
  return (
    <>
      <MenuLayer />
      <TopBar />
      <BottomBar />
    </>
  );
}
