import { useQuery } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";
import { IconBuildings } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { api, call } from "@/lib/api.ts";
import { useCompany, useDeal, usePerson } from "@/lib/crm.ts";
import { keys } from "@/lib/query-keys.ts";
import { space } from "@/theme/tokens.ts";
import { EditCompanyForm, EditDealForm, EditPersonForm } from "./edit-record-forms.tsx";
import { NewCompanyForm, NewDealForm, NewPersonForm } from "./new-record-forms.tsx";

export type RecordFormKind = "company" | "person" | "deal";

export const isRecordFormKind = (kind: string | undefined): kind is RecordFormKind =>
  kind === "company" || kind === "person" || kind === "deal";

/**
 * The sheet that makes or edits a record: a new one without `id` (on `companyId`'s company when
 * given), else the record with `id`, prefilled once it has loaded.
 */
export function RecordFormSheet(props: { kind: RecordFormKind; id?: string; companyId?: string }) {
  const { kind, id, companyId } = props;
  if (!id) {
    const company = companyId ? { id: companyId, name: "" } : null;
    if (kind === "person") return <NewPersonForm company={company} />;
    if (kind === "deal") return <NewDealForm company={company} />;
    return <NewCompanyForm />;
  }
  if (kind === "person") return <EditPerson id={id} />;
  if (kind === "deal") return <EditDeal id={id} />;
  return <EditCompany id={id} />;
}

function EditCompany({ id }: { id: string }) {
  const query = useCompany(id);
  if (!query.data) return <Pending failed={query.isError} />;
  return <EditCompanyForm company={query.data.company} />;
}

function EditPerson({ id }: { id: string }) {
  const query = usePerson(id);
  const company = useCompanyChoice(query.data?.person.companyId ?? null);
  if (!query.data || !company.ready) return <Pending failed={query.isError || company.failed} />;
  return <EditPersonForm person={query.data.person} company={company.choice} />;
}

function EditDeal({ id }: { id: string }) {
  const query = useDeal(id);
  const company = useCompanyChoice(query.data?.deal.companyId ?? null);
  if (!query.data || !company.ready) return <Pending failed={query.isError || company.failed} />;
  return <EditDealForm deal={query.data.deal} company={company.choice} />;
}

function useCompanyChoice(companyId: string | null) {
  const query = useQuery({
    queryKey: keys.crmRecord("company", companyId ?? ""),
    queryFn: ({ signal }) =>
      call(api.crm.companies[":id"].$get({ param: { id: companyId ?? "" } }, { init: { signal } })),
    enabled: !!companyId,
  });
  if (!companyId) return { ready: true, failed: false, choice: null };
  if (!query.data) return { ready: false, failed: query.isError, choice: null };
  return { ready: true, failed: false, choice: { id: companyId, name: query.data.company.name } };
}

function Pending({ failed }: { failed: boolean }) {
  if (failed) return <EmptyState icon={IconBuildings} title="This record didn't load" />;
  return (
    <View style={styles.pending}>
      <Skeleton width="40%" height={20} />
      <Skeleton width="100%" height={52} />
      <Skeleton width="100%" height={52} />
    </View>
  );
}

const styles = StyleSheet.create({
  pending: { padding: space(4), gap: space(3) },
});
