import { Stack, router, useLocalSearchParams } from "expo-router";
import { LinkPage } from "@/components/drive/link-page.tsx";

/** A Drive link, or `node` inside a shared folder: what the web's `/s/<shareId>` shows. */
export default function SharedLink() {
  const { shareId, node, name } = useLocalSearchParams<{
    shareId: string;
    node?: string;
    name?: string;
  }>();
  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      {router.canGoBack() ? null : (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button onPress={() => router.replace("/")}>Done</Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <LinkPage shareId={shareId} node={node} />
    </>
  );
}
