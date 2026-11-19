import { Redirect, useLocalSearchParams } from "expo-router";
import { RecordFormSheet, isRecordFormKind } from "@/components/crm/record-form-sheet.tsx";

/** A sheet over the CRM: a new company, person or deal, or one being edited (`id`). */
export default function RecordForm() {
  const { kind, id, companyId } = useLocalSearchParams<{
    kind?: string;
    id?: string;
    companyId?: string;
  }>();
  if (!isRecordFormKind(kind)) return <Redirect href="/crm" />;
  return <RecordFormSheet kind={kind} id={id} companyId={companyId} />;
}
