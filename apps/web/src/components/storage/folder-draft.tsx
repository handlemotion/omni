// A new folder in the list before the Worker has it (`use-folder-drafts.ts`): a card or a row
// like the folder it becomes, its name a field while it is being named. On a card the name wraps
// as it grows, as Finder's icon view does; on a row it stays one line and scrolls.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GridListItem } from "@/components/ui/grid-list";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FinishedBy, FolderDraft } from "@/hooks/use-folder-drafts.ts";
import { NAME_MAX, typedName } from "@/lib/storage-names.ts";
import { KEEP_IN_MENU } from "./file-card.tsx";
import { FileTile } from "./file-glyph.tsx";
import { FolderArt } from "./folder-art.tsx";

export interface DraftHandlers {
  finish: (key: string, value: string, by: FinishedBy) => "stay" | "done";
  onType: (key: string, value: string) => void;
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
/**
 * Keeps the field's presses, keys and focus from the list around it: the row would take focus
 * on a press (ending the name); arrows, Home, End and letters would move through the list; and
 * focus arriving from the keyboard would send the list back to the item it last had focused.
 */
const KEEP_IN_FIELD = {
  ...KEEP_IN_MENU,
  onMouseDown: stop,
  onTouchStart: stop,
  onFocus: stop,
  onBlur: stop,
};

export function DraftCard(props: { draft: FolderDraft; handlers: DraftHandlers }) {
  const { draft } = props;
  return (
    <GridListItem
      id={draft.key}
      textValue={draft.name}
      // As FileCard lays a folder out, so nothing moves when the folder replaces it.
      className="flex-col items-stretch gap-2 rounded-xl p-1.5"
    >
      <FolderArt />
      <div className="flex min-w-0 flex-col gap-1 ps-0.5">
        {draft.step === "naming" ? (
          <NameField draft={draft} handlers={props.handlers} multiline />
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
        <NameField draft={draft} handlers={props.handlers} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground">{draft.name}</span>
      )}
    </GridListItem>
  );
}

/**
 * The name being typed: focused with its text selected, Enter or leaving it creates the folder,
 * Esc keeps the name it was given. A name Enter cannot take stays here, selected again.
 */
function NameField(props: { draft: FolderDraft; handlers: DraftHandlers; multiline?: boolean }) {
  const { draft, handlers } = props;
  const [value, setValue] = useState(draft.name);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Before paint, so the first key typed already replaces the name.
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.select();
  }, []);
  // A press anywhere else ends the name, as in Finder. Most presses move focus and blur the
  // field already, but a list's empty space keeps focus where it is (React Aria's lists hold it).
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const field = ref.current;
      if (field && !field.contains(event.target as Node)) field.blur();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  const change = (next: string) => {
    const clean = typedName(next);
    setValue(clean);
    handlers.onType(draft.key, clean);
  };
  const finish = (by: FinishedBy) => {
    if (handlers.finish(draft.key, value, by) === "stay") ref.current?.select();
  };
  const field = {
    ref,
    value,
    "aria-label": "Folder name",
    autoComplete: "off",
    spellCheck: false,
    maxLength: NAME_MAX,
    onBlur: () => finish("blur"),
    onKeyDown: (event: React.KeyboardEvent) => {
      event.stopPropagation();
      // An input method's Enter picks a candidate; it does not finish the name.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finish("enter");
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish("escape");
      }
    },
  };
  return (
    <span
      {...KEEP_IN_FIELD}
      // Out by the field's padding and border, so its text sits where the name will.
      className={`flex min-w-0 flex-1 ${props.multiline ? "-mx-1.75 -my-0.75" : "-ms-2.25"}`}
    >
      {props.multiline ? (
        <Textarea
          {...field}
          rows={1}
          onChange={(event) => change(event.target.value)}
          // A card's caption: one line, growing a line at a time as the name wraps. 16px on a
          // phone, as the primitive keeps it, so iOS does not zoom in on focus.
          className="min-h-0 resize-none px-1.5 py-0.5 break-words sm:px-1.5 sm:py-0.5 sm:text-sm"
        />
      ) : (
        <Input {...field} size="sm" onChange={(event) => change(event.target.value)} />
      )}
    </span>
  );
}
