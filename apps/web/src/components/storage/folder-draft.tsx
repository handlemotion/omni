import { GridListItem } from "@/components/ui/grid-list";
import type { FolderDraft } from "@/hooks/use-folder-drafts.ts";
import type { FinishedBy } from "@/lib/storage-names.ts";
import { FileTile } from "./file-glyph.tsx";
import { FolderArt } from "./folder-art.tsx";
import { FIELD_OFFSET, NameField } from "./name-field.tsx";

export interface DraftHandlers {
  finish: (key: string, value: string, by: FinishedBy) => "stay" | "done";
  onType: (key: string, value: string) => void;
}

export function DraftCard(props: { draft: FolderDraft; handlers: DraftHandlers }) {
  const { draft } = props;
  return (
    <GridListItem
      id={draft.key}
      textValue={draft.name}
      className="flex-col items-stretch gap-2 rounded-xl p-1.5"
    >
      <FolderArt />
      <div className="flex min-w-0 flex-col gap-1 ps-0.5">
        {draft.step === "naming" ? (
          <DraftName draft={draft} handlers={props.handlers} multiline />
        ) : (
          <span className="truncate text-sm text-foreground">{draft.name}</span>
        )}
        <span className="truncate text-xs text-muted-foreground">Folder</span>
      </div>
    </GridListItem>
  );
}

export function DraftRow(props: { draft: FolderDraft; handlers: DraftHandlers }) {
  const { draft } = props;
  return (
    <GridListItem
      id={draft.key}
      textValue={draft.name}
      className="mx-2.5 h-12 gap-3 rounded-lg ps-2 pe-1"
    >
      <FileTile kind="folder" />
      {draft.step === "naming" ? (
        <DraftName draft={draft} handlers={props.handlers} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground">{draft.name}</span>
      )}
    </GridListItem>
  );
}

function DraftName(props: { draft: FolderDraft; handlers: DraftHandlers; multiline?: boolean }) {
  const { draft, handlers } = props;
  return (
    <NameField
      name={draft.name}
      label="Folder name"
      select="all"
      multiline={props.multiline}
      className={props.multiline ? FIELD_OFFSET.card : FIELD_OFFSET.row}
      onType={(value) => handlers.onType(draft.key, value)}
      onFinish={(value, by) => handlers.finish(draft.key, value, by)}
    />
  );
}
