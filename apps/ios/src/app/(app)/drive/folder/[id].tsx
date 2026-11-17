import { Stack, useLocalSearchParams } from "expo-router";
import { NodeRow } from "@/components/drive/node-row.tsx";
import { IconFolder } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { DRIVE_PAGES, useFolder } from "@/lib/drive.ts";

/** A folder's contents, folders first. Its name comes along from the row that opened it. */
export default function Folder() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const query = useFolder({ parent: id });
  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      <InfiniteList
        query={query}
        keyOf={(node) => node.id}
        renderItem={(node) => <NodeRow node={node} />}
        icon={IconFolder}
        empty={DRIVE_PAGES.my.empty}
        separatorInset={64}
      />
    </>
  );
}
