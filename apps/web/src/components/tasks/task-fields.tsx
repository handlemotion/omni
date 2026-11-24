import { dayOf, dueAtOf, onRecord, type CrmTask } from "@omni/client";
import { parseDate, type CalendarDate } from "@internationalized/date";
import { useState, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components/Button";
import { Group } from "react-aria-components/Group";
import { cn } from "cn";
import {
  IconBuildings,
  IconCalendar,
  IconCircle,
  IconCircleAlert,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleHalf,
  IconCircleX,
  IconHandshake,
  IconLink,
  IconMinus,
  IconSignalHigh,
  IconSignalLow,
  IconSignalMedium,
  IconUserRound,
  IconX,
} from "@/components/icons/central";
import { Button, buttonStyles } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Link } from "@/components/ui/link";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { MemberAvatar, NoMemberAvatar } from "@/components/crm/member-avatar.tsx";
import { useRecordHref } from "@/components/crm/record-trail.tsx";
import { RecordPicker, useMemberNames } from "@/components/crm/task-dialog.tsx";
import { taskRecord, type TaskChange } from "@/lib/crm-tasks.ts";
import { DAY_YEAR } from "@/lib/dates.ts";
import { statusOf, type TaskPriority, type TaskStatus } from "@/lib/task-status.ts";

type Glyph = typeof IconCircle;

/** Each status: its name, its glyph and the colour the glyph takes. */
export const STATUSES: Record<TaskStatus, { label: string; icon: Glyph; tone: string }> = {
  backlog: { label: "Backlog", icon: IconCircleDashed, tone: "text-muted-foreground" },
  todo: { label: "To do", icon: IconCircle, tone: "text-muted-foreground" },
  in_progress: { label: "In progress", icon: IconCircleHalf, tone: "text-warning" },
  done: { label: "Done", icon: IconCircleCheck, tone: "text-success" },
  cancelled: { label: "Cancelled", icon: IconCircleX, tone: "text-muted-foreground" },
};
const STATUS_ORDER: TaskStatus[] = ["backlog", "todo", "in_progress", "done", "cancelled"];

const NO_PRIORITY = "none";
type PriorityKey = TaskPriority | typeof NO_PRIORITY;

/** Each priority, most first, then none. */
export const PRIORITIES: Record<PriorityKey, { label: string; icon: Glyph }> = {
  urgent: { label: "Urgent", icon: IconCircleAlert },
  high: { label: "High", icon: IconSignalHigh },
  medium: { label: "Medium", icon: IconSignalMedium },
  low: { label: "Low", icon: IconSignalLow },
  none: { label: "No priority", icon: IconMinus },
};
const PRIORITY_ORDER: PriorityKey[] = ["urgent", "high", "medium", "low", NO_PRIORITY];

/** A status's glyph in its colour: wrapped, so a button's icon colour does not take it over. */
export function StatusIcon(props: { status: TaskStatus; className?: string }) {
  const { icon: Icon, tone } = STATUSES[props.status];
  return (
    <span aria-hidden className={cn("flex shrink-0", tone, props.className)}>
      <Icon className="size-3.5" />
    </span>
  );
}

/** A label and its value, one row of the task's details. */
export function PropertyRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="group/property flex min-h-7.5 items-center gap-3">
      <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{props.children}</div>
    </div>
  );
}

export function StatusField(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const status = statusOf(props.task);
  return (
    <PropertyRow label="Status">
      <MenuTrigger>
        <Button intent="property" size="property" aria-label={`Status: ${STATUSES[status].label}`}>
          <StatusIcon status={status} />
          <span className="truncate">{STATUSES[status].label}</span>
        </Button>
        <Menu
          placement="bottom start"
          aria-label="Status"
          selectionMode="single"
          selectedKeys={[status]}
        >
          {STATUS_ORDER.map((id) => {
            const { icon: ItemIcon, label, tone } = STATUSES[id];
            return (
              <MenuItem
                key={id}
                id={id}
                textValue={label}
                onAction={() => id !== status && props.onSave({ status: id })}
              >
                <ItemIcon className={tone} />
                <MenuLabel>{label}</MenuLabel>
              </MenuItem>
            );
          })}
        </Menu>
      </MenuTrigger>
    </PropertyRow>
  );
}

export function PriorityField(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const current: PriorityKey = props.task.priority ?? NO_PRIORITY;
  const { icon: Icon, label } = PRIORITIES[current];
  const set = current !== NO_PRIORITY;
  return (
    <PropertyRow label="Priority">
      <MenuTrigger>
        <Button
          intent={set ? "property" : "property-plain"}
          size="property"
          data-empty={set ? undefined : ""}
          aria-label={set ? `Priority: ${label}` : "Set priority"}
        >
          <Icon />
          <span className="truncate">{set ? label : "Set priority"}</span>
        </Button>
        <Menu
          placement="bottom start"
          aria-label="Priority"
          selectionMode="single"
          selectedKeys={[current]}
        >
          {PRIORITY_ORDER.map((id) => {
            const { icon: ItemIcon, label: itemLabel } = PRIORITIES[id];
            return (
              <MenuItem
                key={id}
                id={id}
                textValue={itemLabel}
                onAction={() =>
                  id !== current && props.onSave({ priority: id === NO_PRIORITY ? null : id })
                }
              >
                <ItemIcon />
                <MenuLabel>{itemLabel}</MenuLabel>
              </MenuItem>
            );
          })}
        </Menu>
      </MenuTrigger>
    </PropertyRow>
  );
}

const NOBODY = "nobody";

export function AssigneeField(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const people = useMemberNames();
  const value = props.task.assigneeMemberId;
  const chosen = people.find((person) => person.id === value);
  return (
    <PropertyRow label="Assignee">
      <MenuTrigger>
        <Button
          intent="property-plain"
          size="property"
          data-empty={chosen ? undefined : ""}
          aria-label={chosen ? `Assignee: ${chosen.name}` : "Assign"}
        >
          {chosen ? <MemberAvatar name={chosen.name} image={chosen.image} /> : <IconUserRound />}
          <span className="truncate">{chosen?.name ?? "Assign"}</span>
        </Button>
        <Menu
          placement="bottom start"
          aria-label="Assignee"
          selectionMode="single"
          selectedKeys={[value ?? NOBODY]}
        >
          {[...people, { id: NOBODY, name: "Nobody", image: null }].map((person) => (
            <MenuItem
              key={person.id}
              id={person.id}
              textValue={person.name}
              onAction={() => {
                const next = person.id === NOBODY ? null : person.id;
                if (next !== value) props.onSave({ assigneeMemberId: next });
              }}
            >
              {person.id === NOBODY ? (
                <NoMemberAvatar />
              ) : (
                <MemberAvatar name={person.name} image={person.image} />
              )}
              <MenuLabel>{person.name}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
    </PropertyRow>
  );
}

export function DueField(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const [open, setOpen] = useState(false);
  const day = dayOf(props.task.dueAt) || null;
  const save = (next: string | null) => {
    if (next !== day) props.onSave({ dueAt: dueAtOf(next ?? "") });
  };
  const clear = day && (
    <Button
      intent="plain"
      size="sm"
      className="w-full"
      onPress={() => {
        setOpen(false);
        save(null);
      }}
    >
      Clear date
    </Button>
  );
  return (
    <PropertyRow label="Due date">
      <DatePicker
        aria-label="Due date"
        value={day ? parseDate(day) : null}
        isOpen={open}
        onOpenChange={setOpen}
        onChange={(next: CalendarDate | null) => save(next?.toString() ?? null)}
        popover={{ placement: "bottom start", footer: clear }}
        className="min-w-0"
      >
        <Group className="flex">
          <AriaButton
            data-empty={day ? undefined : ""}
            className={buttonStyles({ intent: "property-plain", size: "property" })}
          >
            <IconCalendar />
            <span className="truncate tabular-nums">
              {day ? DAY_YEAR.format(new Date(`${day}T00:00`)) : "Set due date"}
            </span>
          </AriaButton>
        </Group>
      </DatePicker>
    </PropertyRow>
  );
}

const RECORD_ICONS: Record<"companies" | "people" | "deals", Glyph> = {
  companies: IconBuildings,
  people: IconUserRound,
  deals: IconHandshake,
};

/**
 * The record the task is on, a link to it, which can be taken off; on none, a way to pick one
 * (for a private task, where the workspace has the CRM, that puts it in the CRM).
 */
export function RecordField(props: {
  task: CrmTask;
  onSave: (change: TaskChange) => void;
  isPrivate?: boolean;
}) {
  const record = taskRecord(props.task);
  const recordHref = useRecordHref();
  const [picking, setPicking] = useState(false);
  const label = props.isPrivate ? "Add to CRM" : "Linked to";
  if (record) {
    const Icon = RECORD_ICONS[record.kind];
    return (
      <PropertyRow label="Linked to">
        <Link
          href={recordHref(record.kind, record.id)}
          className={buttonStyles({ intent: "property", size: "property" })}
        >
          <Icon />
          <span className="truncate">{record.name}</span>
        </Link>
        <Button
          size="sq-2xs"
          intent="plain"
          aria-label="Remove from record"
          className="opacity-0 group-hover/property:opacity-100 focus-visible:opacity-100"
          onPress={() => props.onSave({ companyId: null, personId: null, dealId: null })}
        >
          <IconX />
        </Button>
      </PropertyRow>
    );
  }
  return (
    <PropertyRow label={label}>
      {picking ? (
        <div className="w-full">
          <RecordPicker
            label={false}
            autoFocus
            value={null}
            onBlur={() => setPicking(false)}
            onChange={(picked) => {
              if (!picked) return;
              setPicking(false);
              props.onSave({
                companyId: null,
                personId: null,
                dealId: null,
                ...onRecord(picked.kind, picked.id),
              });
            }}
          />
        </div>
      ) : (
        <Button
          intent="property-plain"
          size="property"
          data-empty=""
          onPress={() => setPicking(true)}
        >
          <IconLink />
          <span className="truncate">Add to record</span>
        </Button>
      )}
    </PropertyRow>
  );
}
