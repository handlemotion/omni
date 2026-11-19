import { Stack, useLocalSearchParams } from "expo-router";
import { useAddMenu } from "@/components/drive/add-menu.tsx";
import { NodeItem } from "@/components/drive/node-item.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconFolder } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { DRIVE_PAGES, useFolder } from "@/lib/drive.ts";

/** A folder's contents, folders first. Its name comes along from the row that opened it. */
export default function Folder() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const query = useFolder({ parent: id });
  const add = useAddMenu({ parentId: id });
  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      <Stack.Toolbar placement="right">{add}</Stack.Toolbar>
      <InfiniteList
        query={query}
        keyOf={(node) => node.id}
        renderItem={(node) => <NodeItem node={node} />}
        icon={IconFolder}
        empty={DRIVE_PAGES.my.empty}
      />
      <UploadsPanel />
    </>
  );
}
