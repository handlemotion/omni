import { router } from "expo-router";
import { View } from "react-native";
import { IconFileText } from "@/components/icons.ts";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import {
  contractLine,
  contractStatus,
  useContracts,
  type ContractOwner,
} from "@/lib/crm-contracts.ts";

/** A record's contracts, newest first; each opens its own screen. Nothing when it has none. */
export function ContractsSection({ owner }: { owner: ContractOwner }) {
  const contracts = useContracts(owner).data ?? [];
  if (!contracts.length) return null;
  return (
    <View>
      <SectionHeading label="Contracts" />
      {contracts.map((contract) => (
        <ItemRow
          key={contract.id}
          icon={IconFileText}
          title={contract.title}
          detail={contractLine(contract)}
          trailing={contractStatus(contract)}
          onPress={() =>
            router.push({
              pathname: "/crm/contract/[id]",
              params: { id: contract.id, kind: owner.kind, owner: owner.id },
            })
          }
        />
      ))}
    </View>
  );
}
