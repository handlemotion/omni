import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { InlineRename, Renaming } from "@/hooks/use-inline-rename.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { NAME_MAX, typedName, type FinishedBy } from "@/lib/storage-names.ts";

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
const KEEP_IN_FIELD = {
  onPointerDown: stop,
  onPointerUp: stop,
  onClick: stop,
  onKeyDown: stop,
  onMouseDown: stop,
  onTouchStart: stop,
  onFocus: stop,
  onBlur: stop,
};

/** Where a name's extension starts ("report.pdf" → 6), or its length when it has none. */
export function stemLength(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

export function NameField(props: {
  name: string;
  label: string;
  /** "stem" selects a file's name up to its extension. */
  select: "all" | "stem";
  /** A card's caption: wraps, a line at a time. */
  multiline?: boolean | undefined;
  /** "stay" keeps the field, its text selected again. */
  onFinish: (value: string, by: FinishedBy) => "stay" | "done";
  onType?: ((value: string) => void) | undefined;
  /** The wrapper's offset, so the field's text sits where the name was. */
  className?: string | undefined;
}) {
  const [value, setValue] = useState(props.name);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(
      0,
      props.select === "stem" ? stemLength(field.value) : field.value.length,
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, as the field appears
  }, []);
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
    props.onType?.(clean);
  };
  const finish = (by: FinishedBy) => {
    if (done.current) return;
    if (props.onFinish(value, by) === "stay") ref.current?.select();
    else done.current = true;
  };
  const field = {
    ref,
    value,
    "aria-label": props.label,
    autoComplete: "off",
    spellCheck: false,
    maxLength: NAME_MAX,
    onBlur: () => {
      if (document.hasFocus()) finish("blur");
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      event.stopPropagation();
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
    <span {...KEEP_IN_FIELD} className={`flex min-w-0 flex-1 ${props.className ?? ""}`}>
      {props.multiline ? (
        <Textarea
          {...field}
          rows={1}
          onChange={(event) => change(event.target.value)}
          className="min-h-0 resize-none px-1.5 py-0.5 break-words sm:px-1.5 sm:py-0.5 sm:text-sm"
        />
      ) : (
        <Input {...field} size="sm" onChange={(event) => change(event.target.value)} />
      )}
    </span>
  );
}

/** Out by the field's padding and border, so its text sits where the name will. */
export const FIELD_OFFSET = { card: "-mx-1.75 -my-0.75", row: "-ms-2.25" } as const;

/** An item being renamed: where it is in that, and the way to finish its name. */
export type ItemName = Renaming & { finish: InlineRename["finish"] };

/**
 * A card's or row's name: a field while it is renamed, then the new name until the Worker has
 * it, else the name.
 */
export function NodeName(props: {
  node: StorageNode;
  name?: ItemName | undefined;
  /** A card's caption, rather than a row's name. */
  card?: boolean;
}) {
  const { node, name } = props;
  if (name?.step === "naming") {
    return (
      <NameField
        name={node.name}
        label="Name"
        select={node.kind === "file" ? "stem" : "all"}
        multiline={props.card}
        className={props.card ? FIELD_OFFSET.card : FIELD_OFFSET.row}
        onFinish={(value, by) => name.finish(node, value, by)}
      />
    );
  }
  return (
    <span className={`truncate text-foreground ${props.card ? "text-sm" : "min-w-0 flex-1"}`}>
      {name?.step === "saving" ? name.name : node.name}
    </span>
  );
}
