import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * A box to write in and send from: a note on a record's timeline, a comment on a task. It grows
 * with the text; ⌘Enter or its button sends it.
 */
export function NoteBox(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  label: string;
  placeholder: string;
  submitLabel: string;
  maxLength?: number;
}) {
  const empty = !props.value.trim();
  return (
    <form
      className="flex cursor-text flex-col gap-2 rounded-xl border bg-background px-3 pt-2.5 pb-2.5"
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("textarea, button")) return;
        event.preventDefault();
        event.currentTarget.querySelector("textarea")?.focus();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) props.onSubmit();
      }}
    >
      <Textarea
        plain
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        aria-label={props.label}
        maxLength={props.maxLength ?? 20_000}
        placeholder={props.placeholder}
        className="field-sizing-content max-h-60 min-h-6 resize-none py-0 sm:py-0"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !empty) props.onSubmit();
        }}
      />
      <Button type="submit" size="sm" className="self-end" isDisabled={empty}>
        {props.submitLabel}
      </Button>
    </form>
  );
}
