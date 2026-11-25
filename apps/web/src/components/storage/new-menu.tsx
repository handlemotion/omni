import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  IconFolderPlus,
  IconNewDoc,
  IconPlus,
  IconTable,
  IconUsers,
} from "@/components/icons/central";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarItemTrigger, SidebarLabel } from "@/components/ui/sidebar";
import { useNewDoc } from "@/hooks/use-new-doc.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { storageDraftsQuery } from "@/lib/storage-find.ts";
import type { StorageNode, StoragePlace } from "@/lib/storage.ts";
import { requestNewFolder } from "./folder-context.tsx";
import { storageErrorToast } from "./storage-errors.ts";

export const DRAFTS_PATH = "/files/drafts";

function useNewTarget() {
  const { place: pathname } = useWorkspacePaths();
  const drafts = useQuery(storageDraftsQuery()).data;
  const [, files, kind, first, second] = pathname.split("/");
  if (files === "files" && kind === "t" && first) {
    const place: StoragePlace = second
      ? { parentId: decodeURIComponent(second) }
      : { teamspaceId: decodeURIComponent(first) };
    return { place, path: pathname };
  }
  if (files === "files" && kind === "my" && first) {
    return { place: { parentId: decodeURIComponent(first) }, path: pathname };
  }
  return { place: drafts ? { parentId: drafts } : null, path: DRAFTS_PATH };
}

/** The Drive sidebar's top row: New, a menu that makes a doc, a sheet, a folder or a space. */
export function NewMenu(props: { onNewSpace: () => void }) {
  const target = useNewTarget();
  const navigate = useNavigate();
  const { href } = useWorkspacePaths();
  const mailbox = useSearch({
    strict: false,
    select: (search) => (search as { mailbox?: string }).mailbox,
  });
  const kept = mailbox ? `mailbox=${encodeURIComponent(mailbox)}` : "";
  const open = (node: StorageNode) =>
    void navigate({
      href: href(`${target.path}?${kept ? `${kept}&` : ""}file=${encodeURIComponent(node.id)}`),
    });
  const doc = useNewDoc(target.place ?? { space: "personal" }, undefined, open);
  const ready = target.place !== null;
  return (
    <MenuTrigger>
      <SidebarItemTrigger aria-label="New">
        <IconPlus />
        <SidebarLabel>New</SidebarLabel>
      </SidebarItemTrigger>
      <Menu placement="bottom start" aria-label="New" popover={{ className: "min-w-56" }}>
        <MenuItem
          id="doc"
          textValue="New doc"
          isDisabled={!ready || doc.isPending}
          onAction={() =>
            doc.mutate(undefined, {
              onError: (error) => storageErrorToast(error, "The doc was not made"),
            })
          }
        >
          <IconNewDoc data-slot="icon" />
          <MenuLabel>New doc</MenuLabel>
        </MenuItem>
        <MenuItem id="sheet" textValue="New sheet" isDisabled>
          <IconTable data-slot="icon" />
          <MenuLabel>New sheet</MenuLabel>
        </MenuItem>
        <MenuItem
          id="folder"
          textValue="New folder"
          isDisabled={!ready}
          onAction={() => {
            if (!target.place) return;
            requestNewFolder(target.place);
            void navigate({ href: href(kept ? `${target.path}?${kept}` : target.path) });
          }}
        >
          <IconFolderPlus data-slot="icon" />
          <MenuLabel>New folder</MenuLabel>
        </MenuItem>
        <MenuSeparator />
        <MenuItem id="space" textValue="New space" onAction={props.onNewSpace}>
          <IconUsers data-slot="icon" />
          <MenuLabel>New space</MenuLabel>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
