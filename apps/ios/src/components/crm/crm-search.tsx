import { ScrollView, StyleSheet } from "react-native";
import { IconBuildings } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { useScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { useCrmSearch } from "@/lib/crm.ts";
import { space } from "@/theme/tokens.ts";
import { CompanyRow, DealRow, PersonRow } from "./record-rows.tsx";

/** The people, companies and deals `q` names, each kind under its heading; a tap opens one. */
export function CrmSearch({ q, footerSpace }: { q: string; footerSpace: number }) {
  const search = useCrmSearch(q);
  const onScroll = useScrollEdge();
  if (search.isPending) return <ListSkeleton />;
  const found = search.data;
  const none = !found || found.people.length + found.companies.length + found.deals.length === 0;
  return (
    <ScrollView
      onScroll={onScroll}
      scrollEventThrottle={16}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.list, { paddingBottom: space(8) + footerSpace }]}
    >
      {none ? (
        <EmptyState
          icon={IconBuildings}
          title={search.isError ? "Search didn't load" : "No results"}
        />
      ) : null}
      {found?.people.length ? <SectionHeading variant="group" label="People" /> : null}
      {found?.people.map((person) => (
        <PersonRow key={person.id} person={person} />
      ))}
      {found?.companies.length ? <SectionHeading variant="group" label="Companies" /> : null}
      {found?.companies.map((company) => (
        <CompanyRow key={company.id} company={company} />
      ))}
      {found?.deals.length ? <SectionHeading variant="group" label="Deals" /> : null}
      {found?.deals.map((deal) => (
        <DealRow key={deal.id} deal={deal} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ list: { flexGrow: 1 } });
