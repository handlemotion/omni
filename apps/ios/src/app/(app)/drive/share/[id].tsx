import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import { ActionSheetIOS, Alert, ScrollView, Share, StyleSheet, Switch, View } from "react-native";
import { SheetHeader } from "@/components/drive/sheet-header.tsx";
import { IconUsers } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { ApiError } from "@/lib/api.ts";
import { driveErrorAlert, useNode } from "@/lib/drive-actions.ts";
import {
  ACCESS,
  ROLES,
  accessLabel,
  roleLabel,
  shareUrl,
  usePutPerson,
  useRemovePerson,
  useSetLink,
  useSharing,
  type DriveGrantRole,
  type DriveLinkChange,
  type DriveSharing,
} from "@/lib/drive-sharing.ts";
import { colors, space } from "@/theme/tokens.ts";

function choose<T extends string>(
  title: string,
  options: { id: T; label: string }[],
  onPick: (id: T) => void,
  destructive?: { label: string; onPress: () => void },
) {
  const labels = [...options.map((o) => o.label), ...(destructive ? [destructive.label] : [])];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title,
      options: [...labels, "Cancel"],
      cancelButtonIndex: labels.length,
      ...(destructive ? { destructiveButtonIndex: options.length } : {}),
    },
    (index) => {
      const option = options[index];
      if (option) onPick(option.id);
      else if (destructive && index === options.length) destructive.onPress();
    },
  );
}

/** Share a file or folder: invite people by email with a role, and set who the link opens for. */
export default function ShareSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const node = useNode(id).data?.node;
  const sharing = useSharing(id);
  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content}>
      <SheetHeader title={node ? `Share “${node.name}”` : "Share"}>
        <Button intent="quiet" style={styles.center} label="Done" onPress={() => router.back()} />
      </SheetHeader>
      <View style={styles.body}>
        {sharing.data ? (
          <>
            <AddPerson nodeId={id} />
            <People sharing={sharing.data.sharing} />
            <GeneralAccess sharing={sharing.data.sharing} />
          </>
        ) : sharing.error instanceof ApiError && sharing.error.status === 403 ? (
          <EmptyState icon={IconUsers} title="You can't share this" />
        ) : sharing.isError ? (
          <EmptyState icon={IconUsers} title="This list didn't load">
            <Button intent="plain" label="Try again" onPress={() => void sharing.refetch()} />
          </EmptyState>
        ) : (
          <ListSkeleton />
        )}
      </View>
    </ScrollView>
  );
}

function AddPerson({ nodeId }: { nodeId: string }) {
  const put = usePutPerson();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<DriveGrantRole>("viewer");
  const address = email.trim();
  const invite = () =>
    address &&
    put.mutate(
      { id: nodeId, email: address, role },
      { onSuccess: () => setEmail(""), onError: driveErrorAlert("They were not added") },
    );
  return (
    <View style={styles.add}>
      <TextField
        label="Email"
        placeholder="name@company.com"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="send"
        onSubmitEditing={invite}
      />
      <View style={styles.line}>
        <Button
          intent="plain"
          label={roleLabel(role)}
          accessibilityLabel={`Role, ${roleLabel(role)}`}
          onPress={() => choose("Role", ROLES, setRole)}
        />
        <Button label="Invite" disabled={!address} isPending={put.isPending} onPress={invite} />
      </View>
    </View>
  );
}

function People({ sharing }: { sharing: DriveSharing }) {
  const put = usePutPerson();
  const remove = useRemovePerson();
  if (!sharing.people.length && !sharing.inherited.length) return null;
  return (
    <Group label="People with access">
      {sharing.people.map((person) => (
        <PersonRow key={person.email} email={person.email}>
          <Button
            intent="quiet"
            style={styles.center}
            label={roleLabel(person.role)}
            accessibilityLabel={`Role for ${person.email}, ${roleLabel(person.role)}`}
            isPending={remove.isPending && remove.variables?.email === person.email}
            onPress={() =>
              choose(
                person.email,
                ROLES,
                (role) =>
                  role !== person.role &&
                  put.mutate(
                    { id: sharing.nodeId, email: person.email, role },
                    { onError: driveErrorAlert("The role was not changed") },
                  ),
                {
                  label: "Remove",
                  onPress: () =>
                    remove.mutate(
                      { id: sharing.nodeId, email: person.email },
                      { onError: driveErrorAlert("They were not removed") },
                    ),
                },
              )
            }
          />
        </PersonRow>
      ))}
      {sharing.inherited.map((person) => (
        <PersonRow
          key={`${person.nodeId}:${person.email}`}
          email={person.email}
          from={person.nodeName}
        >
          <Text size="sm" tone="mutedForeground">
            {roleLabel(person.role)}
          </Text>
        </PersonRow>
      ))}
    </Group>
  );
}

function PersonRow(props: { email: string; from?: string; children: ReactNode }) {
  return (
    <View style={styles.person}>
      <Avatar name={props.email} size={32} />
      <View style={styles.grow}>
        <Text numberOfLines={1}>{props.email}</Text>
        {props.from ? (
          <Text size="xs" tone="mutedForeground" numberOfLines={1}>
            {props.from}
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function GeneralAccess({ sharing }: { sharing: DriveSharing }) {
  const setLink = useSetLink();
  const [copied, setCopied] = useState(false);
  const url = sharing.shareId ? shareUrl(sharing.shareId) : null;
  const resetting = setLink.isPending && !!setLink.variables && "reset" in setLink.variables;
  const choices = ACCESS.filter(
    (a) =>
      a.id !== "anyone" || sharing.policy?.publicLinks !== false || sharing.linkAccess === a.id,
  );
  return (
    <Group label="General access">
      <View style={styles.line}>
        <Button
          intent="plain"
          label={accessLabel(sharing.linkAccess)}
          accessibilityLabel={`General access, ${accessLabel(sharing.linkAccess)}`}
          isPending={setLink.isPending && !resetting}
          onPress={() =>
            choose("General access", choices, (linkAccess) =>
              linkAccess !== sharing.linkAccess
                ? setLink.mutate(
                    { id: sharing.nodeId, linkAccess },
                    { onError: driveErrorAlert("Access was not changed") },
                  )
                : undefined,
            )
          }
        />
      </View>
      {url ? (
        <View style={styles.link}>
          <Text size="sm" tone="mutedForeground" numberOfLines={1} selectable>
            {url}
          </Text>
          <View style={styles.line}>
            <Button
              intent="plain"
              label={copied ? "Copied" : "Copy link"}
              onPress={() => {
                void Clipboard.setStringAsync(url);
                setCopied(true);
              }}
            />
            <Button intent="plain" label="Share" onPress={() => void Share.share({ url })} />
            <Button
              intent="quiet"
              style={styles.center}
              label="Reset link"
              isPending={resetting}
              onPress={() =>
                setLink.mutate(
                  { id: sharing.nodeId, reset: true },
                  {
                    onSuccess: () => setCopied(false),
                    onError: driveErrorAlert("The link was not reset"),
                  },
                )
              }
            />
          </View>
        </View>
      ) : null}
      {sharing.linkAccess !== "restricted" && sharing.link ? (
        <LinkSettings nodeId={sharing.nodeId} link={sharing.link} />
      ) : null}
    </Group>
  );
}

const DAY_MS = 86_400_000;
const EXPIRY: { id: string; label: string; days: number | null }[] = [
  { id: "never", label: "Never", days: null },
  { id: "1", label: "In 1 day", days: 1 },
  { id: "7", label: "In 7 days", days: 7 },
  { id: "30", label: "In 30 days", days: 30 },
];
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function LinkSettings(props: { nodeId: string; link: NonNullable<DriveSharing["link"]> }) {
  const setLink = useSetLink();
  const { link } = props;
  const change = (json: DriveLinkChange, failed: string) =>
    setLink.mutate({ id: props.nodeId, ...json }, { onError: driveErrorAlert(failed) });
  const expiry = link.expiresAt ? `Until ${DATE.format(new Date(link.expiresAt))}` : "Never";
  return (
    <>
      <SettingRow label="Expires">
        <Button
          intent="quiet"
          label={expiry}
          accessibilityLabel={`Expires, ${expiry}`}
          onPress={() =>
            choose("Expires", EXPIRY, (id) => {
              const days = EXPIRY.find((e) => e.id === id)?.days ?? null;
              const expiresAt = days ? new Date(Date.now() + days * DAY_MS).toISOString() : null;
              change({ expiresAt }, "The expiry was not changed");
            })
          }
        />
      </SettingRow>
      <SettingRow label="Password">
        <Button
          intent="quiet"
          label={link.hasPassword ? "Remove" : "Set"}
          accessibilityLabel={link.hasPassword ? "Remove password" : "Set password"}
          onPress={() =>
            link.hasPassword
              ? change({ password: null }, "The password was not removed")
              : Alert.prompt(
                  "Password",
                  undefined,
                  (password) =>
                    password.length >= 4 && change({ password }, "The password was not set"),
                  "secure-text",
                )
          }
        />
      </SettingRow>
      <SettingRow label="Allow downloads">
        <Switch
          accessibilityLabel="Allow downloads"
          value={link.downloads}
          onValueChange={(downloads) => change({ downloads }, "Downloads were not changed")}
        />
      </SettingRow>
    </>
  );
}

function SettingRow(props: { label: string; children: ReactNode }) {
  return (
    <View style={styles.setting}>
      <Text style={styles.grow}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function Group(props: { label: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text size="sm" tone="mutedForeground">
        {props.label}
      </Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignSelf: "center" },
  sheet: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space(8) },
  body: { paddingHorizontal: space(4), gap: space(6) },
  add: { gap: space(3) },
  line: { flexDirection: "row", alignItems: "center", gap: space(2) },
  group: { gap: space(3) },
  person: { flexDirection: "row", alignItems: "center", gap: space(3), minHeight: 44 },
  grow: { flex: 1 },
  link: { gap: space(2) },
  setting: { flexDirection: "row", alignItems: "center", gap: space(3), minHeight: 44 },
});
