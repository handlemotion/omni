import { router } from "expo-router";
import type { ComponentProps } from "react";
import { Avatar } from "@/components/ui/avatar.tsx";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { IconHandshake } from "@/components/icons.ts";
import { dealValue, type CrmCompany, type CrmDeal, type CrmPerson } from "@/lib/crm.ts";

/** What a native `Link` hands the row it wraps (its press), over the row's own tap. */
type Pass = Omit<ComponentProps<typeof ItemRow>, "title">;

export function CompanyRow({ company, ...pass }: { company: CrmCompany } & Pass) {
  return (
    <ItemRow
      lead={
        <Avatar name={company.name} logo={company.domain ? { domain: company.domain } : null} />
      }
      title={company.name}
      detail={company.domain}
      onPress={() => router.push({ pathname: "/crm/company/[id]", params: { id: company.id } })}
      {...pass}
    />
  );
}

export function PersonRow({ person, ...pass }: { person: CrmPerson } & Pass) {
  const email = person.addresses[0]?.address;
  return (
    <ItemRow
      lead={<Avatar name={person.name} logo={email ? { address: email } : null} />}
      title={person.name}
      detail={person.jobTitle ?? email}
      onPress={() => router.push({ pathname: "/crm/person/[id]", params: { id: person.id } })}
      {...pass}
    />
  );
}

export function DealRow({ deal, stage, ...pass }: { deal: CrmDeal; stage?: string } & Pass) {
  return (
    <ItemRow
      icon={IconHandshake}
      title={deal.name}
      detail={stage}
      trailing={dealValue(deal)}
      onPress={() => router.push({ pathname: "/crm/deal/[id]", params: { id: deal.id } })}
      {...pass}
    />
  );
}
