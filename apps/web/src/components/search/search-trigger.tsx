import { IconSearch } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentModule } from "@/components/shell/module-switcher";
import { openSearch } from "./command-menu";

/**
 * Search, in the title bar beside notifications: opens the command menu, as `/` and ⌘K do. In
 * Drive it opens on Drive's files, as Drive's own sidebar has no Search of its own.
 */
export function SearchButton() {
  const module = useCurrentModule();
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label="Search"
        aria-keyshortcuts="/"
        onPress={() => openSearch(module === "files" ? { q: "", scope: "files" } : undefined)}
      >
        <IconSearch />
      </Button>
      <Tooltip>Search</Tooltip>
    </TooltipTrigger>
  );
}
