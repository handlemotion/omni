import { useState, useSyncExternalStore } from "react";
import { IconCircle, IconCircleCheck, IconPlus, IconTrash } from "@/components/icons/central";
import { contextMenuProps } from "@/components/ui/context-menu";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import type { CrmTask, TaskChange } from "@/lib/crm-tasks.ts";

type Step = NonNullable<CrmTask["subtasks"]>[number];

const STEP_MAX = 500;
const lineClass = "h-8 w-full rounded-md px-1.5 text-sm hover:bg-hover focus:bg-hover";

/** The cell a check sits in, so its box starts on the content's left edge. */
export const CHECK_CELL = "flex h-8 w-5 shrink-0 items-center -ms-[1.5px]";

const unsaved = new Map<string, { steps: Step[]; pending: number }>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * The task's checklist: a titled group of steps, each with its check, and a line to add one. While
 * saves are on their way it shows the list as last edited, even if the panel was closed and opened
 * again, not what a refetch brings back.
 */
export function Subtasks(props: {
  task: CrmTask;
  onSave: (change: TaskChange, settled?: () => void) => void;
}) {
  const id = props.task.id;
  const local = useSyncExternalStore(subscribe, () => unsaved.get(id)?.steps);
  const steps = local ?? props.task.subtasks ?? [];
  const put = (subtasks: Step[]) => {
    unsaved.set(id, { steps: subtasks, pending: (unsaved.get(id)?.pending ?? 0) + 1 });
    notify();
    props.onSave({ subtasks }, () => {
      const entry = unsaved.get(id);
      if (!entry) return;
      if (entry.pending > 1) unsaved.set(id, { ...entry, pending: entry.pending - 1 });
      else unsaved.delete(id);
      notify();
    });
  };
  return (
    <section aria-label="Subtasks" className="flex flex-col gap-0.5">
      <h3 className="flex h-7 items-center text-sm text-muted-foreground">Subtasks</h3>
      {steps.map((step) => (
        <SubtaskRow
          key={step.id}
          step={step}
          onChange={(next) => put(steps.map((s) => (s.id === step.id ? next : s)))}
          onRemove={() => put(steps.filter((s) => s.id !== step.id))}
        />
      ))}
      <NewSubtask
        onAdd={(title) => put([...steps, { id: crypto.randomUUID(), title, done: false }])}
      />
    </section>
  );
}

function SubtaskRow(props: { step: Step; onChange: (step: Step) => void; onRemove: () => void }) {
  const { step } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const title = draft.trim();
    if (!title) return props.onRemove();
    if (title !== step.title) props.onChange({ ...step, title });
  };
  return (
    <div
      className="flex items-center"
      {...contextMenuProps(
        () => [
          {
            icon: step.done ? IconCircle : IconCircleCheck,
            label: step.done ? "Reopen subtask" : "Complete subtask",
            onAction: () => props.onChange({ ...step, done: !step.done }),
          },
          "separator",
          { icon: IconTrash, label: "Delete subtask", danger: true, onAction: props.onRemove },
        ],
        step.title,
      )}
    >
      <div className={CHECK_CELL}>
        <CheckboxField
          aria-label={`Complete ${step.title}`}
          isSelected={step.done}
          onChange={(done) => props.onChange({ ...step, done })}
        >
          <Checkbox />
        </CheckboxField>
      </div>
      <TextField
        aria-label="Subtask"
        maxLength={STEP_MAX}
        value={draft ?? step.title}
        onChange={setDraft}
        className="min-w-0 flex-1"
      >
        <Input
          plain
          autoComplete="off"
          className={`${lineClass} ${step.done ? "text-muted-foreground line-through" : ""}`}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      </TextField>
    </div>
  );
}

function NewSubtask(props: { onAdd: (title: string) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const title = draft.trim();
    if (!title) return;
    props.onAdd(title);
    setDraft("");
  };
  return (
    <div className="flex items-center">
      <div className={`${CHECK_CELL} text-muted-foreground`}>
        <span className="flex w-4.25 justify-center">
          <IconPlus className="size-3.5" />
        </span>
      </div>
      <TextField
        aria-label="New subtask"
        maxLength={STEP_MAX}
        value={draft}
        onChange={setDraft}
        className="min-w-0 flex-1"
      >
        <Input
          plain
          autoComplete="off"
          placeholder="Add subtask"
          className={`${lineClass} placeholder:text-muted-foreground`}
          onBlur={add}
          onKeyDown={(event) => event.key === "Enter" && !event.nativeEvent.isComposing && add()}
        />
      </TextField>
    </div>
  );
}
