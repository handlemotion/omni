import { IconBuildings, IconHandshake, IconProjects, IconUsers } from "@/components/icons.ts";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { useCompanies, useDeals, usePeople, useStageNames, type CrmDeal } from "@/lib/crm.ts";
import { CRM_PAGES, filterCount, type CrmPage, type ListView } from "@/lib/crm-lists.ts";
import { CompanyRow, DealRow, PersonRow } from "./record-rows.tsx";
import { RecordListItem } from "./record-list-item.tsx";

/** What an empty list says: nothing archived, nothing that matches, or nothing yet. */
export function emptyText(page: CrmPage, view: ListView) {
  if (view.archived) return "Nothing archived";
  if (filterCount(view)) return "No matches";
  return CRM_PAGES[page].empty;
}

export function CompanyList({ view }: { view: ListView }) {
  return (
    <InfiniteList
      query={useCompanies(view)}
      keyOf={(company) => company.id}
      renderItem={(company) => (
        <RecordListItem kind="companies" record={company}>
          <CompanyRow company={company} />
        </RecordListItem>
      )}
      icon={IconBuildings}
      empty={emptyText("companies", view)}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

export function PersonList({ view }: { view: ListView }) {
  return (
    <InfiniteList
      query={usePeople(view)}
      keyOf={(person) => person.id}
      renderItem={(person) => (
        <RecordListItem kind="people" record={person}>
          <PersonRow person={person} />
        </RecordListItem>
      )}
      icon={IconUsers}
      empty={emptyText("people", view)}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

/** Deals as a list, or the won ones only (Projects). */
export function DealList({ view, projects = false }: { view: ListView; projects?: boolean }) {
  const page = projects ? "projects" : "deals";
  return (
    <InfiniteList
      query={useDeals(view, { projects })}
      keyOf={(deal) => deal.id}
      renderItem={(deal) => <DealItem deal={deal} />}
      icon={projects ? IconProjects : IconHandshake}
      empty={emptyText(page, view)}
      footerSpace={FLOATING_BAR_SPACE}
    />
  );
}

/** A deal's row with its stage, its swipe and its menu. */
export function DealItem({ deal }: { deal: CrmDeal }) {
  const stages = useStageNames().data;
  return (
    <RecordListItem kind="deals" record={deal}>
      <DealRow deal={deal} stage={stages?.get(deal.stageId)} />
    </RecordListItem>
  );
}
