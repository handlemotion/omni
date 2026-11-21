import { IconEllipsis, IconInfo } from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { StorageNode } from "@/lib/storage.ts";

function Row(props: { item: SettingsRowMenuItem }) {
  const { icon: Icon, ...item } = props.item;
  return (
    <MenuItem
      id={item.label}
      textValue={item.label}
      intent={item.danger ? "danger" : undefined}
      isDisabled={item.disabled}
      onAction={item.onAction}
    >
      <Icon data-slot="icon" />
      <MenuLabel>{item.label}</MenuLabel>
    </MenuItem>
  );
}

/**
 * The open file's "⋯": its actions, then whether the details bar shows. A doc's Export and Share
 * live in its own bar (`DocBar`), so they leave this menu.
 */
export function HeaderMenu(props: {
  node: StorageNode;
  items: SettingsRowMenuItem[];
  exports: (() => string | undefined) | undefined;
  details: boolean;
  onDetails: () => void;
  /** Unsaved changes hide the menu of a file edited by hand; a doc saves itself. */
  dirty: boolean;
}) {
  if (props.dirty && !props.exports) return null;
  const items = props.exports
    ? props.items.filter((item) => item.label !== "Share" && !item.label.startsWith("Export as"))
    : props.items;
  return (
    <MenuTrigger>
      <TooltipTrigger delay={400}>
        <Button intent="ghost" size="sq-sm" aria-label={`Actions for ${props.node.name}`}>
          <IconEllipsis />
        </Button>
        <Tooltip>More</Tooltip>
      </TooltipTrigger>
      <Menu placement="bottom end" aria-label={`Actions for ${props.node.name}`}>
        {items.map((item) => (
          <Row key={item.label} item={item} />
        ))}
        <MenuSeparator />
        <Row
          item={{
            icon: IconInfo,
            label: props.details ? "Hide details" : "Show details",
            onAction: props.onDetails,
          }}
        />
      </Menu>
    </MenuTrigger>
  );
}
