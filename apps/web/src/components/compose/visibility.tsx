import { IconGlobe, IconLock } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuDescription, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useComposerState, type ComposerMode } from "./composer-state.tsx";

const VISIBILITY = {
  public: { icon: IconGlobe, label: "Public", short: "Email the customer" },
  hidden: { icon: IconLock, label: "Hidden", short: "Only your team sees it" },
} as const;

/**
 * Who sees what you write, and the menu that changes it: an icon among the composer's tools,
 * beside Attach in a reply and Mention in a note. Each mode's menu item says its consequence, so
 * a hidden note never reads as mail and a public reply never reads as a note.
 */
export function Visibility() {
  const { mode, setMode } = useComposerState();
  const current = VISIBILITY[mode];
  return (
    <MenuTrigger>
      <TooltipTrigger delay={400}>
        <Button
          intent="ghost"
          size="sq-sm"
          aria-label={`Visibility: ${current.label}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <current.icon />
        </Button>
        <Tooltip>{current.label}</Tooltip>
      </TooltipTrigger>
      <Menu
        placement="top start"
        selectionMode="single"
        selectedKeys={[mode]}
        onSelectionChange={(keys) => {
          const next = [...keys][0] as ComposerMode | undefined;
          if (next) setMode(next);
        }}
      >
        {(["public", "hidden"] as const).map((id) => {
          const option = VISIBILITY[id];
          return (
            <MenuItem key={id} id={id} textValue={option.label}>
              <option.icon data-slot="icon" />
              <MenuLabel>{option.label}</MenuLabel>
              <MenuDescription>{option.short}</MenuDescription>
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}
