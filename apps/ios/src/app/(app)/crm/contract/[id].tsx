import { Stack, router, useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { IconFileText } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { LoadingPage } from "@/components/ui/loading-page.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import {
  contractLine,
  contractStatus,
  signedCopyOf,
  signerStatus,
  takesSignedCopy,
  useContracts,
  useVoidContract,
  type CrmContract,
} from "@/lib/crm-contracts.ts";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { gutter, space } from "@/theme/tokens.ts";

const openFile = (id: string) => router.push({ pathname: "/drive/file/[id]", params: { id } });

/** One contract: where signing is, each signer, its files, and what can be done next. */
export default function Contract() {
  const { id, kind, owner } = useLocalSearchParams<{ id: string; kind: string; owner: string }>();
  const query = useContracts({ kind: kind === "companies" ? "companies" : "deals", id: owner });
  const contract = query.data?.find((one) => one.id === id);
  if (query.isPending) {
    return (
      <LoadingPage>
        <View style={styles.head}>
          <Skeleton width="70%" height={28} />
          <Skeleton width="40%" height={16} />
        </View>
      </LoadingPage>
    );
  }
  if (!contract) return <EmptyState icon={IconFileText} title="This contract is gone" />;
  return <ContractView contract={contract} kind={kind} owner={owner} />;
}

function ContractView(props: { contract: CrmContract; kind: string; owner: string }) {
  const { contract } = props;
  const voiding = useVoidContract();
  const signing = contract.signing;
  const line = contractLine(contract);
  const signedCopy = signedCopyOf(contract);
  const canSend = contract.status === "draft" && !!contract.documentNodeId;
  const out = contract.status === "sent" && signing?.status === "sent";
  const signedBy = contract.signedBy ?? [];
  const params = { id: contract.id, kind: props.kind, owner: props.owner };
  const confirmVoid = () =>
    Alert.alert("Void this request?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Void",
        style: "destructive",
        onPress: () =>
          voiding.mutate(contract.id, {
            onError: (error) => crmErrorAlert(error, "It was not voided"),
          }),
      },
    ]);
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Text size="title" weight="medium" accessibilityRole="header" selectable>
            {contract.title}
          </Text>
          <Text tone="mutedForeground">{contractStatus(contract)}</Text>
          {line ? (
            <Text size="sm" tone="mutedForeground" tabular>
              {line}
            </Text>
          ) : null}
        </View>
        {signing ? (
          <View>
            <SectionHeading label="Signers" />
            {signing.signers.map((signer) => (
              <ItemRow
                key={signer.email}
                lead={<Avatar name={signer.name} logo={{ address: signer.email }} />}
                title={signer.name}
                detail={signer.email}
                trailing={signerStatus(signer)}
              />
            ))}
          </View>
        ) : null}
        {signedBy.length ? (
          <View>
            <SectionHeading label="Signed by" />
            {signedBy.map((signer, index) => (
              <ItemRow
                key={index}
                lead={
                  <Avatar
                    name={signer.name}
                    logo={signer.email ? { address: signer.email } : undefined}
                  />
                }
                title={signer.name}
                detail={signer.email ?? undefined}
                trailing="Signed"
              />
            ))}
          </View>
        ) : null}
        <View>
          <SectionHeading label="Files" />
          {contract.documentNodeId ? (
            <ItemRow
              icon={IconFileText}
              title="Document"
              onPress={() => openFile(contract.documentNodeId!)}
            />
          ) : null}
          {signedCopy ? (
            <ItemRow icon={IconFileText} title="Signed copy" onPress={() => openFile(signedCopy)} />
          ) : null}
        </View>
        <View style={styles.actions}>
          {canSend ? (
            <Button
              label="Send for signature"
              onPress={() => router.push({ pathname: "/crm/send-contract", params })}
            />
          ) : null}
          {takesSignedCopy(contract) ? (
            <Button
              intent={canSend ? "outline" : "primary"}
              label="Upload signed copy"
              onPress={() => router.push({ pathname: "/crm/signed-copy", params })}
            />
          ) : null}
          {out ? (
            <Button
              intent="outline"
              label="Void"
              isPending={voiding.isPending}
              onPress={confirmVoid}
            />
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: space(16), gap: space(6) },
  head: { paddingHorizontal: gutter, paddingTop: space(2), gap: space(1) },
  actions: { paddingHorizontal: gutter, gap: space(3) },
});
