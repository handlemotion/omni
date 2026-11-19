import { useLocalSearchParams } from "expo-router";
import { DriveSearch } from "@/components/drive/drive-search.tsx";
import { NodeItem, TrashItem } from "@/components/drive/node-item.tsx";
import { NodeRow } from "@/components/drive/node-row.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconFolder, IconFolderShared, IconTrash } from "@/components/icons.ts";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { useMenu } from "@/components/shell/menu-context.tsx";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { DRIVE_PAGES, drivePageIn, useFolder, useSharedWithMe, useTrash } from "@/lib/drive.ts";
import { useDebounced } from "@/lib/use-debounced.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";

/** A Drive page: a space's top, what was shared with you, or Trash. */
export default function DriveHome() {
  const params = useLocalSearchParams<{ page?: string }>();
  const company = hasCrm(useWorkspace().active);
  const page = drivePageIn(params.page, company);
  const space = page === "shared" ? "shared" : "personal";
  const typed = useMenu().query.trim();
  const q = useDebounced(typed);
  return (
    <ModuleRoot>
      {typed ? (
        <DriveSearch q={q} footerSpace={FLOATING_BAR_SPACE} />
      ) : page === "sharedWithMe" ? (
        <SharedWithMe />
      ) : page === "trash" ? (
        <Trash />
      ) : (
        <Space space={space} />
      )}
      <UploadsPanel />
    </ModuleRoot>
  );
}

function Space({ space }: { space: "personal" | "shared" }) {
  const query = useFolder({ space });
  return (
    <InfiniteList
      key={space}
      query={query}
      keyOf={(node) => node.id}
      renderItem={(node) => <NodeItem node={node} />}
      icon={IconFolder}
      empty={DRIVE_PAGES.my.empty}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

function SharedWithMe() {
  const query = useSharedWithMe();
  return (
    <InfiniteList
      query={query}
      keyOf={(item) => item.node.id}
      renderItem={(item) => <NodeRow node={item.node} detail={item.orgName} />}
      icon={IconFolderShared}
      empty={DRIVE_PAGES.sharedWithMe.empty}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

function Trash() {
  const query = useTrash();
  return (
    <InfiniteList
      query={query}
      keyOf={(node) => node.id}
      renderItem={(node) => <TrashItem node={node} />}
      icon={IconTrash}
      empty={DRIVE_PAGES.trash.empty}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}
