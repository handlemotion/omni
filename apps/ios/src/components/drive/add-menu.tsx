import { Stack } from "expo-router";
import { Alert } from "react-native";
import {
  NEW_FOLDER_NAME,
  driveErrorAlert,
  useCreateFolder,
  type DrivePlace,
} from "@/lib/drive-actions.ts";
import { addUploads, pickDocuments, pickMedia } from "@/lib/drive-uploads.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The "+" in a space's or a folder's header: New folder and the two uploads, the web page's
 * New folder and Upload. It is the `Stack.Toolbar.Menu` element itself, to put inside a
 * `Stack.Toolbar` as is (a header toolbar drops any other component), so this is a hook.
 */
export function useAddMenu(place: DrivePlace) {
  const create = useCreateFolder().mutate;
  const workspace = useWorkspace().active?.id;
  const newFolder = () =>
    Alert.prompt(
      "New folder",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Create",
          isPreferred: true,
          onPress: (value?: string) =>
            create(
              { name: value?.trim() || NEW_FOLDER_NAME, place },
              { onError: driveErrorAlert("The folder was not created") },
            ),
        },
      ],
      "plain-text",
    );
  const upload = async (pick: typeof pickDocuments) => {
    const files = await pick().catch(() => []);
    if (workspace && files.length) addUploads(files, { workspace, place });
  };
  return (
    <Stack.Toolbar.Menu icon="plus" accessibilityLabel="New">
      <Stack.Toolbar.MenuAction icon="folder.badge.plus" onPress={newFolder}>
        New folder
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction icon="doc.badge.plus" onPress={() => void upload(pickDocuments)}>
        Upload file
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction icon="photo.badge.plus" onPress={() => void upload(pickMedia)}>
        Upload photo or video
      </Stack.Toolbar.MenuAction>
    </Stack.Toolbar.Menu>
  );
}
