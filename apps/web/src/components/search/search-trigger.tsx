import { IconSearch } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { openSearch } from "./command-menu";

/** Search, in the title bar beside notifications: opens the command menu, as `/` and ⌘K do. */
export function SearchButton() {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label="Search"
        aria-keyshortcuts="/"
        onPress={() => openSearch()}
      >
        <IconSearch />
      </Button>
      <Tooltip>Search</Tooltip>
    </TooltipTrigger>
  );
}
