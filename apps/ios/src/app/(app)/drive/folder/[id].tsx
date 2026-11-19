import { Stack, useLocalSearchParams } from "expo-router";
import { useAddMenu } from "@/components/drive/add-menu.tsx";
import { DriveList } from "@/components/drive/drive-list.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { DRIVE_PAGES } from "@/lib/drive.ts";

/** A folder's contents: its folders as a grid of cards, then its files as rows. Its name comes along from the row that opened it. */
export default function Folder() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const add = useAddMenu({ parentId: id });
  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      <Stack.Toolbar placement="right">{add}</Stack.Toolbar>
      <DriveList place={{ parent: id }} empty={DRIVE_PAGES.my.empty} />
      <UploadsPanel />
    </>
  );
}
