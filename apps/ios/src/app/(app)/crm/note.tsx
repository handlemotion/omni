import { Redirect, useLocalSearchParams } from "expo-router";
import { NoteSheet } from "@/components/crm/note-sheet.tsx";
import type { CrmRecordKind } from "@/lib/crm-mutations.ts";

const isRecord = (record: string | undefined): record is CrmRecordKind =>
  record === "companies" || record === "people" || record === "deals";

/** A sheet over a record: a new note on it, or one of yours being edited (`noteId`). */
export default function Note() {
  const { record, id, noteId } = useLocalSearchParams<{
    record?: string;
    id?: string;
    noteId?: string;
  }>();
  if (!isRecord(record) || !id) return <Redirect href="/crm" />;
  return <NoteSheet record={record} id={id} noteId={noteId} />;
}
