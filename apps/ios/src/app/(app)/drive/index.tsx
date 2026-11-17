import { Stack, router, useLocalSearchParams } from "expo-router";
import { NodeRow } from "@/components/drive/node-row.tsx";
import { IconFolder, IconFolderShared, IconTrash } from "@/components/icons.ts";
import { ModuleToolbar } from "@/components/shell/module-toolbar.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import {
  DRIVE_PAGES,
  isDrivePage,
  useFolder,
  useSharedWithMe,
  useTrash,
  type DrivePage,
} from "@/lib/drive.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";

const ALL = Object.entries(DRIVE_PAGES).map(([id, page]) => ({ ...page, id: id as DrivePage }));
const INSET = 64;

/** A Drive page: a space's top, what was shared with you, or Trash. */
export default function DriveHome() {
  const params = useLocalSearchParams<{ page?: string }>();
  const company = hasCrm(useWorkspace().active);
  const pages = ALL.filter((page) => company || !("company" in page));
  const page =
    isDrivePage(params.page) && pages.some((p) => p.id === params.page) ? params.page : "my";
  return (
    <>
      <Stack.Screen options={{ title: DRIVE_PAGES[page].label }} />
      <ModuleToolbar pages={pages} current={page} onPage={(id) => router.setParams({ page: id })} />
      {page === "sharedWithMe" ? (
        <SharedWithMe />
      ) : page === "trash" ? (
        <Trash />
      ) : (
        <Space space={page === "shared" ? "shared" : "personal"} />
      )}
    </>
  );
}

function Space({ space }: { space: "personal" | "shared" }) {
  const query = useFolder({ space });
  return (
    <InfiniteList
      key={space}
      query={query}
      keyOf={(node) => node.id}
      renderItem={(node) => <NodeRow node={node} />}
      icon={IconFolder}
      empty={DRIVE_PAGES.my.empty}
      separatorInset={INSET}
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
      separatorInset={INSET}
    />
  );
}

function Trash() {
  const query = useTrash();
  return (
    <InfiniteList
      query={query}
      keyOf={(node) => node.id}
      renderItem={(node) => <NodeRow node={node} />}
      icon={IconTrash}
      empty={DRIVE_PAGES.trash.empty}
      separatorInset={INSET}
    />
  );
}
