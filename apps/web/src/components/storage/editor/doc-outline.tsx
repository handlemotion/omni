import { useState } from "react";
import { IconH1, IconH2, IconH3, IconOutline } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

const LEVEL_ICON = { H1: IconH1, H2: IconH2, H3: IconH3 } as const;

interface Heading {
  id: string;
  text: string;
  level: keyof typeof LEVEL_ICON;
  element: Element;
}

function headingsOf(page: Element | null) {
  const found: Heading[] = [];
  for (const [i, element] of [...(page?.querySelectorAll("h1, h2, h3") ?? [])].entries()) {
    const text = element.textContent?.trim();
    if (text)
      found.push({ id: String(i), text, level: element.tagName as Heading["level"], element });
  }
  return found;
}

/**
 * The doc's outline: its headings, read from the page when opened, each one scrolled to when
 * picked. `page` finds the doc's page in this panel.
 */
export function DocOutline(props: { page: () => Element | null }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  return (
    <MenuTrigger onOpenChange={(open) => open && setHeadings(headingsOf(props.page()))}>
      <TooltipTrigger delay={400}>
        <Button intent="plain" size="sq-sm" aria-label="Outline">
          <IconOutline />
        </Button>
        <Tooltip>Outline</Tooltip>
      </TooltipTrigger>
      <Menu
        aria-label="Outline"
        placement="bottom start"
        popover={{ className: "min-w-64", offset: 4 }}
        renderEmptyState={() => (
          <div className="px-2.5 py-1.5 text-muted-foreground">No headings</div>
        )}
      >
        {headings.map((heading) => {
          const Icon = LEVEL_ICON[heading.level];
          return (
            <MenuItem
              key={heading.id}
              id={heading.id}
              textValue={heading.text}
              onAction={() =>
                heading.element.scrollIntoView({ block: "start", behavior: "smooth" })
              }
            >
              <Icon data-slot="icon" />
              <MenuLabel>{heading.text}</MenuLabel>
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}
