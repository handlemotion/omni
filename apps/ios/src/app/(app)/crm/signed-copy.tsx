import DateTimePicker from "@react-native-community/datetimepicker";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { fromDay, toDay } from "@/components/crm/form-fields.tsx";
import { SheetForm } from "@/components/crm/sheet-form.tsx";
import { IconCalendar, IconFileText, IconPlus, IconX } from "@/components/icons.ts";
import { MenuRow } from "@/components/shell/menu-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { useQuery } from "@tanstack/react-query";
import { api, call } from "@/lib/api.ts";
import { dayText } from "@/lib/crm.ts";
import { useSignedCopy, useContracts, type CrmContract } from "@/lib/crm-contracts.ts";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { useRecordFolder, type FileRecordKind } from "@/lib/crm-files.ts";
import { driveErrorAlert } from "@/lib/drive-actions.ts";
import { uploadFile } from "@/lib/drive-upload.ts";
import { keys } from "@/lib/query-keys.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { colors, space } from "@/theme/tokens.ts";

const middayOf = (day: string) => {
  const date = fromDay(day);
  date.setHours(12);
  return date.toISOString();
};

interface Draft {
  key: number;
  name: string;
  email: string;
}

/**
 * A sheet over a contract signed elsewhere (a client's portal, paper): its executed PDF, uploaded
 * into the record's folder, the day it was signed, and who signed. A deal's people are the first rows.
 */
export default function SignedCopy() {
  const { id, kind, owner } = useLocalSearchParams<{ id: string; kind: string; owner: string }>();
  const isDeal = kind !== "companies";
  const contract = useContracts({ kind: isDeal ? "deals" : "companies", id: owner }).data?.find(
    (one) => one.id === id,
  );
  const dealId = contract?.dealId ?? (isDeal ? owner : null);
  const deal = useQuery({
    queryKey: keys.crmRecord("deal", dealId ?? ""),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].$get({ param: { id: dealId! } }, { init: { signal } })),
    enabled: !!dealId,
  });
  if (!contract || (dealId && deal.isPending)) return null;
  const starting = (deal.data?.people ?? [])
    .flatMap((person) => {
      const email = person.addresses[0]?.address;
      return email ? [{ name: person.name, email }] : [];
    })
    .map((row, key) => ({ key, ...row }));
  return (
    <SignedCopyForm
      contract={contract}
      record={{ kind: isDeal ? "deals" : "companies", id: owner }}
      starting={starting.length ? starting : [{ key: 0, name: "", email: "" }]}
    />
  );
}

function usePdfUpload(record: { kind: FileRecordKind; id: string }) {
  const folder = useRecordFolder();
  const workspace = useWorkspace().active?.id;
  const [pending, setPending] = useState(false);
  const pick = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
    }).catch(() => null);
    const asset = picked && !picked.canceled ? picked.assets[0] : null;
    if (!asset || !workspace) return null;
    setPending(true);
    try {
      const { nodeId: parentId } = await folder.mutateAsync(record);
      const node = await uploadFile({
        file: {
          uri: asset.uri,
          name: asset.name,
          size: asset.size ?? new File(asset.uri).size,
          mimeType: asset.mimeType ?? "application/pdf",
        },
        place: { parentId },
        workspace,
        signal: new AbortController().signal,
        onOpened: () => {},
        onProgress: () => {},
      });
      return { id: node.id, name: node.name };
    } catch (error) {
      driveErrorAlert("The signed copy was not uploaded")(error);
      return null;
    } finally {
      setPending(false);
    }
  };
  return { pending, pick };
}

function SignedCopyForm(props: {
  contract: CrmContract;
  record: { kind: FileRecordKind; id: string };
  starting: Draft[];
}) {
  const { contract } = props;
  const save = useSignedCopy();
  const upload = usePdfUpload(props.record);
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const recordedDay = contract.signedAt ? toDay(new Date(contract.signedAt)) : null;
  const [day, setDay] = useState(recordedDay ?? toDay(new Date()));
  const [picking, setPicking] = useState(false);
  const [drafts, setDrafts] = useState(props.starting);
  const [next, setNext] = useState(props.starting.length + 1);
  const signers = drafts
    .map((draft) => ({ name: draft.name.trim(), email: draft.email.trim() || null }))
    .filter((signer) => signer.name || signer.email);
  const ready = !!file && signers.every((signer) => signer.name);
  const change = (key: number, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  return (
    <SheetForm
      title="Signed copy"
      action="Save"
      disabled={!ready || upload.pending}
      saving={save.isPending}
      onSubmit={() => {
        if (!file) return;
        const signedAt = day === recordedDay ? contract.signedAt! : middayOf(day);
        save.mutate(
          { id: contract.id, nodeId: file.id, signedAt, signers },
          {
            onSuccess: () => router.back(),
            onError: (error) => crmErrorAlert(error, "The signed copy was not saved"),
          },
        );
      }}
    >
      <MenuRow
        icon={IconFileText}
        muted
        label={upload.pending ? "Uploading…" : (file?.name ?? "Choose PDF")}
        chevron
        onPress={async () => {
          if (upload.pending) return;
          const done = await upload.pick();
          if (done) setFile(done);
        }}
      />
      <View>
        <MenuRow
          icon={IconCalendar}
          muted
          label="Signed on"
          detail={dayText(day) ?? day}
          chevron
          onPress={() => setPicking(!picking)}
        />
        {picking ? (
          <DateTimePicker
            value={fromDay(day)}
            mode="date"
            display="inline"
            maximumDate={new Date()}
            accentColor={colors.primary}
            onValueChange={(_event, date) => setDay(toDay(date))}
          />
        ) : null}
      </View>
      {drafts.map((draft, index) => (
        <View key={draft.key} style={styles.signer}>
          <View style={styles.fields}>
            <TextField
              label={`Name of signer ${index + 1}`}
              placeholder="Name"
              value={draft.name}
              textContentType="name"
              onChangeText={(name) => change(draft.key, { name })}
            />
            <TextField
              label={`Email of signer ${index + 1}`}
              placeholder="name@company.com"
              value={draft.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              onChangeText={(email) => change(draft.key, { email })}
            />
          </View>
          <IconButton
            icon={IconX}
            label={`Remove signer ${index + 1}`}
            onPress={() => setDrafts((all) => all.filter((d) => d.key !== draft.key))}
          />
        </View>
      ))}
      <Button
        intent="plain"
        icon={IconPlus}
        label="Add signer"
        onPress={() => {
          setDrafts((all) => [...all, { key: next, name: "", email: "" }]);
          setNext(next + 1);
        }}
      />
    </SheetForm>
  );
}

const styles = StyleSheet.create({
  signer: { flexDirection: "row", alignItems: "center", gap: space(2) },
  fields: { flex: 1, gap: space(2) },
});
