import { Redirect, useLocalSearchParams } from "expo-router";
import { CrmSearch } from "@/components/crm/crm-search.tsx";
import { CompanyRow, DealRow, PersonRow } from "@/components/crm/record-rows.tsx";
import { IconBuildings, IconHandshake, IconUsers } from "@/components/icons.ts";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { useMenu } from "@/components/shell/menu-context.tsx";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import {
  CRM_PAGES,
  isCrmPage,
  useCompanies,
  useDeals,
  usePeople,
  useStageNames,
} from "@/lib/crm.ts";
import { useDebounced } from "@/lib/use-debounced.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";

/** A CRM list: Companies, People or Deals. A Personal space has no CRM: it goes to Mail. */
export default function CrmHome() {
  const params = useLocalSearchParams<{ page?: string }>();
  const page = isCrmPage(params.page) ? params.page : "companies";
  const typed = useMenu().query.trim();
  const q = useDebounced(typed);
  if (!hasCrm(useWorkspace().active)) return <Redirect href="/mail" />;
  return (
    <ModuleRoot module="crm">
      {typed ? (
        <CrmSearch q={q} footerSpace={FLOATING_BAR_SPACE} />
      ) : page === "people" ? (
        <People />
      ) : page === "deals" ? (
        <Deals />
      ) : (
        <Companies />
      )}
    </ModuleRoot>
  );
}

function Companies() {
  return (
    <InfiniteList
      query={useCompanies()}
      keyOf={(company) => company.id}
      renderItem={(company) => <CompanyRow company={company} />}
      icon={IconBuildings}
      empty={CRM_PAGES.companies.empty}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

function People() {
  return (
    <InfiniteList
      query={usePeople()}
      keyOf={(person) => person.id}
      renderItem={(person) => <PersonRow person={person} />}
      icon={IconUsers}
      empty={CRM_PAGES.people.empty}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

function Deals() {
  const stages = useStageNames().data;
  return (
    <InfiniteList
      query={useDeals()}
      keyOf={(deal) => deal.id}
      renderItem={(deal) => <DealRow deal={deal} stage={stages?.get(deal.stageId)} />}
      icon={IconHandshake}
      empty={CRM_PAGES.deals.empty}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}
