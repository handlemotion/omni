import { IconLock, IconUserAdd } from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSection, MenuTrigger } from "@/components/ui/menu";
import type { StorageNode } from "@/lib/storage.ts";
import type { EditSession } from "./document-editor.tsx";
import { DocOutline } from "./doc-outline.tsx";
import { DOC_EXPORTS, useDocExport } from "./export-menu.tsx";

/**
 * A doc's second bar, under its header: its outline, then Share, which holds sharing it and
 * exporting it. Absent for anything but a doc being edited.
 */
export function DocBar(props: {
  node: StorageNode;
  items: SettingsRowMenuItem[];
  session: EditSession;
  text: (() => string | undefined) | undefined;
  /** Side by side with the folder: the line between them runs down its edge too. */
  border: boolean;
  /** False on a shared link that forbids downloads: no Export. */
  canExport?: boolean;
}) {
  const { text } = props;
  if (!text) return null;
  return (
    <div
      className={`flex h-11 shrink-0 items-center gap-1 border-b bg-background px-2.5 ${props.border ? "border-s" : ""}`}
    >
      <Outline node={props.node} />
      <div className="flex-1" />
      <Modes {...props} text={text} />
    </div>
  );
}

/** The bar's controls in a doc page's own header: outline and Share, in one line. */
export function DocBarActions(props: {
  node: StorageNode;
  items: SettingsRowMenuItem[];
  session: EditSession;
  text: () => string | undefined;
  canExport?: boolean | undefined;
  /** False while the outline floats beside the page. */
  outline?: boolean;
}) {
  return (
    <>
      {props.outline !== false && <Outline node={props.node} />}
      <Modes {...props} />
    </>
  );
}

function Outline(props: { node: StorageNode }) {
  return (
    <DocOutline
      page={() => document.querySelector(`[data-doc="${props.node.id}"] .document-page`)}
    />
  );
}

function Modes(props: {
  node: StorageNode;
  items: SettingsRowMenuItem[];
  session: EditSession;
  text: () => string | undefined;
  canExport?: boolean | undefined;
}) {
  return (
    <>
      <ShareMenu
        node={props.node}
        items={props.items}
        text={props.text}
        canExport={props.canExport ?? true}
        shareId={props.session.editor.shareId}
      />
    </>
  );
}

function ShareMenu(props: {
  node: StorageNode;
  items: SettingsRowMenuItem[];
  text: () => string | undefined;
  canExport: boolean;
  shareId: string | undefined;
}) {
  const run = useDocExport(props.node, props.text, props.shareId);
  const share = props.items.find((item) => item.label === "Share");
  if (!share && !props.canExport) return null;
  return (
    <MenuTrigger>
      <Button intent="plain" size="sm">
        <IconLock data-slot="icon" />
        Share
      </Button>
      <Menu aria-label="Share" placement="bottom end" popover={{ offset: 4 }}>
        {share && (
          <MenuSection label="Share">
            <MenuItem id="people" textValue="Invite people" onAction={share.onAction}>
              <IconUserAdd data-slot="icon" />
              <MenuLabel>Invite people</MenuLabel>
            </MenuItem>
          </MenuSection>
        )}
        {props.canExport && (
          <MenuSection label="Export">
            {DOC_EXPORTS.map((each) => (
              <MenuItem
                key={each.format}
                id={each.format}
                textValue={each.label}
                onAction={() => run(each.format)}
              >
                <each.icon data-slot="icon" />
                <MenuLabel>{each.label}</MenuLabel>
              </MenuItem>
            ))}
          </MenuSection>
        )}
      </Menu>
    </MenuTrigger>
  );
}
