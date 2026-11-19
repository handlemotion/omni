import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet } from "react-native";
import { TextField } from "@/components/ui/text-field.tsx";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { useCreateNote, useEditNote, type CrmRecordKind } from "@/lib/crm-mutations.ts";
import { useTimeline } from "@/lib/crm-timeline.ts";
import { space } from "@/theme/tokens.ts";
import { SheetForm } from "./sheet-form.tsx";

const NOTE_MAX = 20_000;
const onSuccess = () => router.back();

/** Writes a note on a record, or with `noteId` rewrites one of yours from its timeline. */
export function NoteSheet(props: { record: CrmRecordKind; id: string; noteId?: string }) {
  const timeline = useTimeline(props.record, props.id);
  if (!props.noteId) return <NoteForm {...props} />;
  const item = timeline.data?.find((one) => one.kind === "note" && one.id === props.noteId);
  if (item?.kind !== "note") return null;
  return <NoteForm {...props} noteId={item.note.id} body={item.note.body} />;
}

function NoteForm(props: { record: CrmRecordKind; id: string; noteId?: string; body?: string }) {
  const create = useCreateNote();
  const edit = useEditNote();
  const [body, setBody] = useState(props.body ?? "");
  const text = body.trim();
  return (
    <SheetForm
      title={props.noteId ? "Edit note" : "New note"}
      action={props.noteId ? "Save" : "Add note"}
      disabled={!text || text === props.body?.trim()}
      saving={create.isPending || edit.isPending}
      onSubmit={() =>
        props.noteId
          ? edit.mutate(
              { id: props.noteId, body: text },
              { onSuccess, onError: (error) => crmErrorAlert(error, "The note was not changed") },
            )
          : create.mutate(
              { record: props.record, id: props.id, body: text },
              { onSuccess, onError: (error) => crmErrorAlert(error, "The note was not added") },
            )
      }
    >
      <TextField
        label="Note"
        placeholder="Write a note…"
        multiline
        autoFocus
        maxLength={NOTE_MAX}
        value={body}
        onChangeText={setBody}
        style={styles.body}
      />
    </SheetForm>
  );
}

const styles = StyleSheet.create({
  body: { height: 240, paddingTop: space(3), textAlignVertical: "top" },
});
