import { router } from "expo-router";
import { IconBuildings, IconHandshake, IconUserRound } from "@/components/icons.ts";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { dealValue, type CrmCompany, type CrmDeal, type CrmPerson } from "@/lib/crm.ts";

export function CompanyRow({ company }: { company: CrmCompany }) {
  return (
    <ItemRow
      icon={IconBuildings}
      title={company.name}
      detail={company.domain}
      onPress={() => router.push({ pathname: "/crm/company/[id]", params: { id: company.id } })}
    />
  );
}

export function PersonRow({ person }: { person: CrmPerson }) {
  return (
    <ItemRow
      icon={IconUserRound}
      title={person.name}
      detail={person.jobTitle ?? person.addresses[0]?.address}
      onPress={() => router.push({ pathname: "/crm/person/[id]", params: { id: person.id } })}
    />
  );
}

export function DealRow({ deal, stage }: { deal: CrmDeal; stage?: string }) {
  return (
    <ItemRow
      icon={IconHandshake}
      title={deal.name}
      detail={stage}
      trailing={dealValue(deal)}
      onPress={() => router.push({ pathname: "/crm/deal/[id]", params: { id: deal.id } })}
    />
  );
}
