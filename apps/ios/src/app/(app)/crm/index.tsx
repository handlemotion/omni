import { Redirect, Stack, router, useLocalSearchParams } from "expo-router";
import { newRecordButton } from "@/components/crm/new-record-button.tsx";
import { CompanyRow, DealRow, PersonRow } from "@/components/crm/record-rows.tsx";
import { IconBuildings, IconHandshake, IconUsers } from "@/components/icons.ts";
import { ModuleToolbar } from "@/components/shell/module-toolbar.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import {
  CRM_PAGES,
  isCrmPage,
  useCompanies,
  useDeals,
  usePeople,
  useStageNames,
  type CrmPage,
} from "@/lib/crm.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";

const PAGES = Object.entries(CRM_PAGES).map(([id, page]) => ({ ...page, id: id as CrmPage }));

/** A CRM list: Companies, People or Deals. A Personal space has no CRM: it goes to Mail. */
export default function CrmHome() {
  const params = useLocalSearchParams<{ page?: string }>();
  const page = isCrmPage(params.page) ? params.page : "companies";
  if (!hasCrm(useWorkspace().active)) return <Redirect href="/mail" />;
  return (
    <>
      <Stack.Screen options={{ title: CRM_PAGES[page].label }} />
      <ModuleToolbar
        pages={PAGES}
        current={page}
        onPage={(id) => router.setParams({ page: id })}
        actions={newRecordButton(page)}
      />
      {page === "people" ? <People /> : page === "deals" ? <Deals /> : <Companies />}
    </>
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
    />
  );
}
