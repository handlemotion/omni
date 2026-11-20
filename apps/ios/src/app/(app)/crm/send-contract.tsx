import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SheetForm } from "@/components/crm/sheet-form.tsx";
import { IconPlus, IconX } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { useQuery } from "@tanstack/react-query";
import { api, call } from "@/lib/api.ts";
import { keys } from "@/lib/query-keys.ts";
import { useContracts, useSendContract } from "@/lib/crm-contracts.ts";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { space } from "@/theme/tokens.ts";

interface Draft {
  key: number;
  name: string;
  email: string;
}

/** A sheet over a contract: who signs it. A deal's people with an address are the first rows. */
export default function SendContract() {
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
  const people = deal.data?.people ?? [];
  const starting = people
    .flatMap((person) => {
      const email = person.addresses[0]?.address;
      return email ? [{ name: person.name, email }] : [];
    })
    .map((row, key) => ({ key, ...row }));
  if (dealId && deal.isPending) return null;
  return (
    <SignersForm
      id={id}
      title={contract?.title ?? "Contract"}
      starting={starting.length ? starting : [{ key: 0, name: "", email: "" }]}
    />
  );
}

function SignersForm(props: { id: string; title: string; starting: Draft[] }) {
  const send = useSendContract();
  const [drafts, setDrafts] = useState(props.starting);
  const [next, setNext] = useState(props.starting.length + 1);
  const signers = drafts
    .map((draft) => ({ name: draft.name.trim(), email: draft.email.trim() }))
    .filter((signer) => signer.name || signer.email);
  const ready = signers.length > 0 && signers.every((signer) => signer.name && signer.email);
  const change = (key: number, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  return (
    <SheetForm
      title={`Send “${props.title}”`}
      action="Send"
      disabled={!ready}
      saving={send.isPending}
      onSubmit={() =>
        send.mutate(
          { id: props.id, signers },
          {
            onSuccess: () => router.back(),
            onError: (error) => crmErrorAlert(error, "The contract was not sent"),
          },
        )
      }
    >
      {drafts.map((draft, index) => (
        <View key={draft.key} style={styles.signer}>
          <View style={styles.fields}>
            <TextField
              label={`Name of signer ${index + 1}`}
              placeholder="Name"
              value={draft.name}
              autoFocus={index === 0 && !draft.name}
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
            disabled={drafts.length === 1}
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
