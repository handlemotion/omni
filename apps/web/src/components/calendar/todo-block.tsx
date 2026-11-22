import { cn } from "cn";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { CanvasButton } from "@/components/ui/canvas-button";
import { endDrag, leadOf, startDrag } from "@/lib/calendar-drag.ts";
import { HOUR_PX, type Placed, type Timed } from "@/lib/calendar-grid.ts";
import type { CrmTask } from "@/lib/crm-tasks.ts";

/** A to-do as the grid holds it: its own span beside the events it overlaps. */
export interface TodoItem extends Timed {
  kind: "todo";
  task: CrmTask;
}

const ROUND =
  "w-4.25 shrink-0 gap-x-0 overflow-hidden **:data-[slot=control-label]:hidden **:data-[slot=indicator]:rounded-full";

/** A to-do's round check, alone. */
export function TodoCheck(props: {
  task: CrmTask;
  onTodo?: (task: CrmTask, done: boolean) => void;
}) {
  const done = !!props.task.completedAt;
  return (
    <CheckboxField
      aria-label={done ? `Reopen ${props.task.title}` : `Complete ${props.task.title}`}
      isSelected={done}
      onChange={(next: boolean) => props.onTodo?.(props.task, next)}
      className={ROUND}
    >
      <Checkbox />
    </CheckboxField>
  );
}

/**
 * A timed to-do on the hours: a quiet outlined block with its check, so it reads as something to
 * do rather than a meeting. Dragging it moves its due time; pressing it opens the to-do.
 */
export function TodoBlock(props: {
  day: Date;
  placed: Placed<TodoItem>;
  onTodo?: (task: CrmTask, done: boolean) => void;
  onOpenTodo?: (task: CrmTask) => void;
}) {
  const { event: item, from, to, column, columns } = props.placed;
  const done = !!item.task.completedAt;
  return (
    <div
      data-todo={item.task.id}
      data-calendar-keys="off"
      draggable
      onDragStart={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        startDrag(
          event,
          { kind: "todo", task: item.task },
          ((event.clientY - box.top) / HOUR_PX) * 60,
          leadOf(props.day, item.start, from),
        );
      }}
      onDragEnd={endDrag}
      className={cn(
        "absolute flex cursor-grab items-start gap-1.5 overflow-hidden rounded-lg border border-dashed border-border bg-background px-1.5 py-1 text-xs active:cursor-grabbing",
        done && "opacity-60",
      )}
      style={{
        top: (from / 60) * HOUR_PX,
        height: Math.max(((to - from) / 60) * HOUR_PX - 2, 18),
        left: `calc(${(column / columns) * 100}% + 2px)`,
        width: `calc(${100 / columns}% - 4px)`,
      }}
    >
      <TodoCheck task={item.task} onTodo={props.onTodo} />
      <CanvasButton
        onClick={() => props.onOpenTodo?.(item.task)}
        className={cn("min-w-0 flex-1 truncate text-start font-medium", done && "line-through")}
      >
        {item.task.title}
      </CanvasButton>
    </div>
  );
}

/** A dated to-do on its day: its check, then its title. */
export function TodoChip(props: {
  task: CrmTask;
  onTodo?: (task: CrmTask, done: boolean) => void;
  onOpenTodo?: (task: CrmTask) => void;
}) {
  const { task } = props;
  const done = !!task.completedAt;
  return (
    <div
      data-todo={task.id}
      data-calendar-keys="off"
      draggable
      onDragStart={(e) => startDrag(e, { kind: "todo", task })}
      onDragEnd={endDrag}
      className="flex min-w-0 cursor-grab items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-hover active:cursor-grabbing"
    >
      <TodoCheck task={task} onTodo={props.onTodo} />
      <CanvasButton
        onClick={() => props.onOpenTodo?.(task)}
        className={cn(
          "min-w-0 flex-1 truncate text-start text-xs",
          done && "text-muted-foreground line-through",
        )}
      >
        {task.title}
      </CanvasButton>
    </div>
  );
}
