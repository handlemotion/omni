import { FlashList } from "@shopify/flash-list";
import { Stack, router } from "expo-router";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { IconFile, IconFolder } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { LoadingPage } from "@/components/ui/loading-page.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { driveErrorText } from "@/lib/drive-actions.ts";
import {
  isGone,
  isLocked,
  shareLinkFile,
  useDriveLink,
  useUnlockLink,
  type DriveLink,
  type DriveLinkUpload,
} from "@/lib/drive-link.ts";
import { fileSize, type DriveNode } from "@/lib/drive.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { colors, radius, space } from "@/theme/tokens.ts";
import { NodeRow } from "./node-row.tsx";

/**
 * What a Drive link opens, as the web's link page shows it: a file with Download (unless the
 * link is view only), a folder's contents, a file still uploading with its progress until it
 * becomes the file, and the password a protected link asks for first.
 */
export function LinkPage({ shareId, node }: { shareId: string; node?: string | undefined }) {
  const link = useDriveLink(shareId, node);
  useSplashDone(!link.isPending);
  const first = link.data?.pages[0];
  if (!first) {
    if (link.isPending) return <LoadingPage>{null}</LoadingPage>;
    if (isLocked(link.error)) return <Unlock shareId={shareId} />;
    if (isGone(link.error)) return <EmptyState icon={IconFile} title="Not found" />;
    return (
      <EmptyState icon={IconFile} title="This link didn't load">
        <Button intent="plain" label="Try again" onPress={() => void link.refetch()} />
      </EmptyState>
    );
  }
  const item = first.item.node;
  const upload = first.uploading?.find((one) => one.id === item.id);
  return (
    <>
      <Stack.Screen options={{ title: item.name }} />
      {upload ? (
        <Uploading upload={upload} />
      ) : item.kind === "folder" ? (
        <Folder shareId={shareId} pages={link.data?.pages ?? []} link={link} />
      ) : (
        <SharedFile shareId={shareId} node={item} downloads={first.downloads !== false} />
      )}
    </>
  );
}

function Unlock({ shareId }: { shareId: string }) {
  const [password, setPassword] = useState("");
  const unlock = useUnlockLink(shareId);
  const open = () =>
    password &&
    unlock.mutate(password, {
      onError: (error) => Alert.alert(driveErrorText(error, "The link did not open")),
    });
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.center}>
      <View style={styles.unlock}>
        <TextField
          label="Password"
          placeholder="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoFocus
          autoComplete="off"
          returnKeyType="go"
          onSubmitEditing={open}
        />
        <Button label="Open" disabled={!password} isPending={unlock.isPending} onPress={open} />
      </View>
    </KeyboardAvoidingView>
  );
}

const percentOf = (upload: DriveLinkUpload) =>
  upload.size ? Math.floor((upload.uploadedBytes / upload.size) * 100) : 0;

function Uploading({ upload }: { upload: DriveLinkUpload }) {
  return (
    <EmptyState icon={IconFile} title={upload.name}>
      <View style={styles.progress}>
        <UploadProgress upload={upload} />
      </View>
    </EmptyState>
  );
}

function UploadProgress({ upload, named }: { upload: DriveLinkUpload; named?: boolean }) {
  const percent = percentOf(upload);
  return (
    <View style={styles.upload}>
      <View style={styles.line}>
        <Text size="sm" numberOfLines={1} style={styles.name}>
          {named ? upload.name : "Uploading"}
        </Text>
        <Text size="sm" tone="mutedForeground" tabular>
          {percent}%
        </Text>
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel={`Uploading ${upload.name}`}
        accessibilityValue={{ min: 0, max: 100, now: percent }}
      >
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
    </View>
  );
}

function SharedFile(props: { shareId: string; node: DriveNode; downloads: boolean }) {
  const [pending, setPending] = useState(false);
  const download = () => {
    setPending(true);
    shareLinkFile(props.shareId, props.node)
      .catch((error: unknown) => Alert.alert(driveErrorText(error, "It was not downloaded")))
      .finally(() => setPending(false));
  };
  return (
    <EmptyState icon={IconFile} title={props.node.name}>
      <Text size="sm" tone="mutedForeground" tabular>
        {fileSize(props.node.size)}
      </Text>
      {props.downloads ? (
        <Button intent="plain" label="Download" isPending={pending} onPress={download} />
      ) : null}
    </EmptyState>
  );
}

type Row = { type: "node"; node: DriveNode } | { type: "upload"; upload: DriveLinkUpload };

function Folder({
  shareId,
  pages,
  link,
}: {
  shareId: string;
  pages: DriveLink[];
  link: Pick<
    ReturnType<typeof useDriveLink>,
    "hasNextPage" | "isFetchingNextPage" | "fetchNextPage"
  >;
}) {
  const uploads = pages[0]?.uploading ?? [];
  const nodes = pages.flatMap((page) => page.nodes);
  const rows: Row[] = [
    ...uploads.map((upload) => ({ type: "upload" as const, upload })),
    ...nodes.map((node) => ({ type: "node" as const, node })),
  ];
  if (!rows.length) return <EmptyState icon={IconFolder} title="Empty folder" />;
  return (
    <FlashList
      data={rows}
      keyExtractor={(row) => (row.type === "node" ? row.node.id : `upload:${row.upload.id}`)}
      getItemType={(row) => row.type}
      contentInsetAdjustmentBehavior="automatic"
      onEndReached={() => {
        if (link.hasNextPage && !link.isFetchingNextPage) void link.fetchNextPage();
      }}
      ListFooterComponent={link.isFetchingNextPage ? <ListSkeleton /> : null}
      renderItem={({ item: row }) =>
        row.type === "upload" ? (
          <View style={styles.uploadRow}>
            <UploadProgress upload={row.upload} named />
          </View>
        ) : (
          <NodeRow
            node={row.node}
            onPress={() =>
              router.push({
                pathname: "/s/[shareId]",
                params: { shareId, node: row.node.id, name: row.node.name },
              })
            }
          />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: space(6),
    paddingBottom: space(20),
  },
  unlock: { gap: space(3) },
  progress: { alignSelf: "stretch" },
  upload: { gap: space(1.5) },
  uploadRow: { paddingHorizontal: space(4), paddingVertical: space(3) },
  line: { flexDirection: "row", alignItems: "center", gap: space(2) },
  name: { flex: 1 },
  track: {
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    overflow: "hidden",
  },
  fill: { height: 4, backgroundColor: colors.primary },
});
