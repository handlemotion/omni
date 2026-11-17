import { Button } from "react-aria-components/Button";
import { IconSearch } from "@/components/icons/sidebar";
import { Keyboard } from "@/components/ui/keyboard";
import { openSearch } from "./command-menu";

/**
 * The mail list header's search field: it opens the command menu, as `/` and ⌘K do. In a list
 * header under 448px (the sidebar closed and a thread open), it is an icon like the header's
 * other actions, so the row still fits the 320px list.
 */
export function SearchTrigger() {
  return (
    <Button
      onPress={() => openSearch()}
      aria-label="Search"
      aria-keyshortcuts="/"
      data-search-field
      className="flex h-7 w-60 min-w-24 cursor-text items-center gap-2 rounded-lg border border-input bg-background ps-2 pe-1.25 text-sm text-subtle-foreground outline-hidden hover:border-muted-foreground/30 focus-visible:border-ring/70 @max-md/list-head:w-7 @max-md/list-head:min-w-7 @max-md/list-head:cursor-default @max-md/list-head:justify-center @max-md/list-head:border-0 @max-md/list-head:bg-transparent @max-md/list-head:px-0 @max-md/list-head:hover:bg-accent"
    >
      <IconSearch className="text-muted-foreground" />
      <span className="flex-1 text-start @max-md/list-head:hidden">Search</span>
      <Keyboard className="h-4 min-w-4 @max-md/list-head:hidden">/</Keyboard>
    </Button>
  );
}
