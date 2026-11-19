import { useLocalSearchParams } from "expo-router";
import { DriveList } from "@/components/drive/drive-list.tsx";
import { DriveSearch } from "@/components/drive/drive-search.tsx";
import { TrashItem } from "@/components/drive/node-item.tsx";
import { NodeRow } from "@/components/drive/node-row.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconFolderShared, IconTrash } from "@/components/icons.ts";
import { useMenu } from "@/components/shell/menu-context.tsx";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { DRIVE_PAGES, drivePageIn, useSharedWithMe, useTrash } from "@/lib/drive.ts";
import { useDebounced } from "@/lib/use-debounced.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { floatingFade, space } from "@/theme/tokens.ts";

const CLEAR_OF_FADE = floatingFade - space(8);

/** A Drive page: a space's top, what was shared with you, or Trash. */
export default function DriveHome() {
  const params = useLocalSearchParams<{ page?: string }>();
  const company = hasCrm(useWorkspace().active);
  const page = drivePageIn(params.page, company);
  const where = page === "shared" ? "shared" : "personal";
  const typed = useMenu().query.trim();
  const q = useDebounced(typed);
  return (
    <ModuleRoot>
      {typed ? (
        <DriveSearch q={q} footerSpace={CLEAR_OF_FADE} />
      ) : page === "sharedWithMe" ? (
        <SharedWithMe />
      ) : page === "trash" ? (
        <Trash />
      ) : (
        <Space space={where} />
      )}
      <UploadsPanel />
    </ModuleRoot>
  );
}

function Space({ space: where }: { space: "personal" | "shared" }) {
  return (
    <DriveList
      key={where}
      place={{ space: where }}
      empty={DRIVE_PAGES.my.empty}
      footerSpace={CLEAR_OF_FADE}
      recent
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
      footerSpace={CLEAR_OF_FADE}
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
      footerSpace={CLEAR_OF_FADE}
    />
  );
}
