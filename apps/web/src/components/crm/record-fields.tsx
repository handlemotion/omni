// A record's details, after Attio's "Record details": one row per field, its label muted in a
// 96px column and the value beside it, edited in place. A text value is a borderless field that
// saves when it loses focus or on Enter (Escape puts it back); a choice is a borderless select
// that saves when picked. Rows are 32px, the controls' own height, 2px apart.
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

export function FieldRow(props: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-8 items-center gap-3">
      <span className="w-24 shrink-0 truncate text-sm text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-1 items-center">{props.children}</div>
    </div>
  );
}

/** A text value edited in place; `onSave` gets the trimmed text, null when it was emptied. */
export function TextValue(props: {
  label: string;
  value: string | null;
  onSave: (value: string | null) => void;
  /** Refuses an empty value (a name): emptying it puts the old one back. */
  required?: boolean;
  type?: "text" | "email" | "tel";
  maxLength?: number;
  /** Turns what was typed into what is saved, or `undefined` when it isn't valid. */
  parse?: (text: string) => string | null | undefined;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.value ?? "";
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const text = draft.trim();
    const next = props.parse ? props.parse(text) : text || null;
    if (next === undefined || (props.required && !next)) return;
    if (next !== (props.value ?? null)) props.onSave(next);
  };
  return (
    <FieldRow label={props.label}>
      <TextField
        aria-label={props.label}
        type={props.type}
        maxLength={props.maxLength ?? 500}
        value={shown}
        onChange={setDraft}
        className="w-full"
      >
        <Input
          plain
          autoComplete="off"
          placeholder="–"
          className="h-8 w-full truncate rounded-md px-2 hover:bg-hover focus:bg-hover"
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(null);
              // Blur after the reset, so `commit` sees nothing to save.
              queueMicrotask(() => (event.target as HTMLInputElement).blur());
            }
          }}
        />
      </TextField>
    </FieldRow>
  );
}

/** One of a few values (a stage, an owner), saved when picked. */
export function ChoiceValue<T extends { id: string; name: string }>(props: {
  label: string;
  value: string | null;
  options: T[];
  onSave: (id: string) => void;
}) {
  return (
    <FieldRow label={props.label}>
      <Select
        aria-label={props.label}
        value={props.value}
        onChange={(id) => id && id !== props.value && props.onSave(id)}
        placeholder="–"
        className="w-full"
      >
        <SelectTrigger className="border-transparent bg-transparent enabled:hover:border-transparent enabled:hover:bg-hover" />
        <SelectContent items={props.options}>
          {(option) => (
            <SelectItem id={option.id} textValue={option.name}>
              {option.name}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

/** A value that is another record: its link, with an action after it (change, remove). */
export function LinkValue(props: {
  label: string;
  to?: { kind: "companies" | "people" | "deals"; id: string; name: string } | null;
  action?: ReactNode;
}) {
  const { href: inWorkspace } = useWorkspacePaths();
  return (
    <FieldRow label={props.label}>
      <span className="flex min-w-0 flex-1 items-center gap-1 px-2">
        {props.to ? (
          <Link
            href={inWorkspace(`/crm/${props.to.kind}/${encodeURIComponent(props.to.id)}`)}
            className="truncate text-sm text-foreground underline-offset-2 hover:underline"
          >
            {props.to.name}
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">–</span>
        )}
      </span>
      {props.action}
    </FieldRow>
  );
}

/** A read-only value (a date, a count), with the same insets as the editable ones. */
export function PlainValue(props: { label: string; children: ReactNode }) {
  return (
    <FieldRow label={props.label}>
      <span className="truncate px-2 text-sm text-foreground tabular-nums">
        {props.children ?? <span className="text-muted-foreground">–</span>}
      </span>
    </FieldRow>
  );
}
