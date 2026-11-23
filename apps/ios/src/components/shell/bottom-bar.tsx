import { FloatingBar } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace, type Module } from "./menu-nav.ts";

/** What each module's search field says; a module without one has no search yet. */
export const SEARCH_PLACEHOLDER: Partial<Record<Module, string>> = {
  mail: "Search mail",
  drive: "Search files",
  crm: "Search records",
};

/**
 * The open search field on a module's root page, above the keyboard. The top bar's search button
 * opens it; it reopens with its query when the user comes back from one of its results.
 */
export function BottomBar() {
  const shell = useMenu();
  const { module } = useMenuPlace();
  const { setQuery, setSearchIn } = shell;
  const placeholder = SEARCH_PLACEHOLDER[module];
  if (shell.searchIn !== module || !placeholder) return null;
  return (
    <FloatingBar
      key={module}
      placeholder={placeholder}
      initial={{ query: shell.query, focus: !shell.query }}
      query={shell.query}
      onSearch={setQuery}
      onStop={() => setSearchIn(null)}
    />
  );
}
