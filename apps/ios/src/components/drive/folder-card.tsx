import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useFolder, type DriveNode } from "@/lib/drive.ts";
import { space } from "@/theme/tokens.ts";
import { FolderArt } from "./folder-art.tsx";

function countOf(contents: DriveNode[], more: boolean) {
  const noun = contents.every((one) => one.kind === "file") ? "file" : "item";
  const one = contents.length === 1 && !more;
  return `${contents.length}${more ? "+" : ""} ${noun}${one ? "" : "s"}`;
}

/**
 * A folder in the grid, as the desktop's card draws it without its chrome: the folder art, then
 * its name and how many files (or items, with folders among them) it holds. Its contents load once the card is drawn, which the
 * list does only near the screen, and open the folder from the cache.
 */
export function FolderCard({ node }: { node: DriveNode }) {
  const contents = useFolder({ parent: node.id });
  return (
    <PressableRow
      style={styles.card}
      accessibilityLabel={node.name}
      onPress={() =>
        router.push({ pathname: "/drive/folder/[id]", params: { id: node.id, name: node.name } })
      }
    >
      <FolderArt contents={contents.data} />
      <View style={styles.text}>
        <Text size="subhead" numberOfLines={1}>
          {node.name}
        </Text>
        <Text size="caption" tone="mutedForeground" tabular numberOfLines={1}>
          {contents.data ? countOf(contents.data, contents.hasNextPage) : " "}
        </Text>
      </View>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 0,
    flexDirection: "column",
    gap: space(2),
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  text: { gap: space(0.5), paddingLeft: space(0.5) },
});
