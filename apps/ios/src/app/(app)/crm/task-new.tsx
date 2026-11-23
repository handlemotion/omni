import type { CrmRecordKind } from "@omni/client";
import { useLocalSearchParams } from "expo-router";
import { TaskSheet } from "@/components/crm/task-sheet.tsx";

const isRecord = (kind: string | undefined): kind is CrmRecordKind =>
  kind === "companies" || kind === "people" || kind === "deals";

/** A sheet for a new task: on a record (`kind`, `id`), or on nothing from the Tasks list. */
export default function NewTask() {
  const { kind, id } = useLocalSearchParams<{ kind?: string; id?: string }>();
  return <TaskSheet record={isRecord(kind) && id ? { kind, id } : undefined} />;
}
