import { useState, type ReactNode } from "react";
import {
  IconArchive,
  IconBoard,
  IconBuildings,
  IconCalendar,
  IconCircleCheck,
  IconFilter,
  IconMoney,
  IconUserRound,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import {
  Menu,
  MenuHeader,
  MenuItem,
  MenuLabel,
  MenuSubMenu,
  MenuTrigger,
} from "@/components/ui/menu";
import { useCrmStages, useOwners } from "@/hooks/use-crm.ts";
import { formatMoney } from "@/lib/crm.ts";
import { CloseDateDialog, ValueRangeDialog } from "./list-range-dialogs.tsx";
import { EveryoneAvatar, MemberAvatar, NoMemberAvatar } from "./member-avatar.tsx";
import { useSelfMemberId } from "./task-dialog.tsx";
import { DAY } from "./record-list.tsx";

/** The filters a list offers, in the order its menu shows them. */
export type FilterKind =
  | "owner"
  | "assignee"
  | "status"
  | "company"
  | "stage"
  | "close"
  | "value"
  | "archived";

/** A list's filters as the URL holds them. Each left out is its default. */
export interface FilterValues {
  owner?: string;
  /** Tasks: a member id, `none` or `anyone`; left out, the person's own. */
  assignee?: string;
  status?: "done";
  company?: "with" | "without";
  stage?: string;
  closeAfter?: string;
  closeBefore?: string;
  minValue?: number;
  maxValue?: number;
  archived?: "only";
}

type Patch = Partial<Record<keyof FilterValues, unknown>>;

const CLEARS: Record<FilterKind, Patch> = {
  owner: { owner: undefined },
  assignee: { assignee: undefined },
  status: { status: undefined },
  company: { company: undefined },
  stage: { stage: undefined },
  close: { closeAfter: undefined, closeBefore: undefined },
  value: { minValue: undefined, maxValue: undefined },
  archived: { archived: undefined },
};

const LABELS: Record<FilterKind, string> = {
  owner: "Owner",
  assignee: "Assignee",
  status: "Status",
  company: "Company",
  stage: "Stage",
  close: "Close date",
  value: "Value",
  archived: "Archived",
};

const ICONS: Record<FilterKind, ReactNode> = {
  owner: <IconUserRound data-slot="icon" />,
  assignee: <IconUserRound data-slot="icon" />,
  status: <IconCircleCheck data-slot="icon" />,
  company: <IconBuildings data-slot="icon" />,
  stage: <IconBoard data-slot="icon" />,
  close: <IconCalendar data-slot="icon" />,
  value: <IconMoney data-slot="icon" />,
  archived: <IconArchive data-slot="icon" />,
};

const isSet = (kind: FilterKind, values: FilterValues) => {
  switch (kind) {
    case "close":
      return !!(values.closeAfter || values.closeBefore);
    case "value":
      return values.minValue !== undefined || values.maxValue !== undefined;
    default:
      return values[kind] !== undefined;
  }
};

const shortDay = (iso: string) => DAY.format(new Date(`${iso}T00:00:00`));

const range = (from: string | null, to: string | null) =>
  from && to ? `${from} – ${to}` : from ? `≥ ${from}` : `≤ ${to}`;

type FilterProps = { kinds: FilterKind[]; values: FilterValues; onChange: (patch: Patch) => void };

type Editing = "close" | "value" | null;

/**
 * Filter, in the page header: one row per filter with its value, each opening its choices, and
 * Reset. The button counts the filters changed from their default, so the list needs no chips.
 */
export function FilterMenu(props: FilterProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const phone = useIsMobile();
  const set = props.kinds.filter((kind) => isSet(kind, props.values)).length;
  const reset = () =>
    props.onChange(Object.assign({}, ...props.kinds.map((kind) => CLEARS[kind])) as Patch);
  return (
    <>
      <MenuTrigger>
        <Button intent="outline" size={phone && !set ? "sq-sm" : "sm"} aria-label="Filter">
          <IconFilter />
          {!phone && "Filter"}
          {set > 0 && <span className="text-muted-foreground tabular-nums">{set}</span>}
        </Button>
        <Menu
          placement="bottom end"
          aria-label="Filters"
          popover={{ className: "w-72 max-w-[calc(100vw-32px)]" }}
        >
          <MenuHeader className="flex items-center justify-between py-1.5 text-muted-foreground">
            Filters
            <Button
              intent="plain"
              size="text"
              className="text-base/6 text-primary sm:text-sm/6"
              isDisabled={!set}
              onPress={reset}
            >
              Reset
            </Button>
          </MenuHeader>
          {props.kinds.map((kind) => (
            <FilterRow
              key={kind}
              kind={kind}
              values={props.values}
              onChange={props.onChange}
              onEdit={setEditing}
            />
          ))}
        </Menu>
      </MenuTrigger>
      <FilterDialogs {...props} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function FilterDialogs(props: FilterProps & { editing: Editing; onClose: () => void }) {
  if (props.editing === "close") {
    return (
      <CloseDateDialog
        after={props.values.closeAfter}
        before={props.values.closeBefore}
        onSave={(closeAfter, closeBefore) => props.onChange({ closeAfter, closeBefore })}
        onClose={props.onClose}
      />
    );
  }
  if (props.editing === "value") {
    return (
      <ValueRangeDialog
        min={props.values.minValue}
        max={props.values.maxValue}
        onSave={(minValue, maxValue) => props.onChange({ minValue, maxValue })}
        onClose={props.onClose}
      />
    );
  }
  return null;
}

function FilterRow(props: {
  kind: FilterKind;
  values: FilterValues;
  onChange: (patch: Patch) => void;
  onEdit: (kind: "close" | "value") => void;
}) {
  const { kind } = props;
  const text = useValueText(kind, props.values);
  const row = (onAction?: () => void) => (
    <MenuItem id={kind} textValue={LABELS[kind]} onAction={onAction} className="pe-7">
      {ICONS[kind]}
      <MenuLabel className="flex min-w-0 items-center gap-3">
        <span className="shrink-0">{LABELS[kind]}</span>
        <span className="ms-auto truncate text-muted-foreground tabular-nums">{text}</span>
      </MenuLabel>
    </MenuItem>
  );
  if (kind === "close" || kind === "value") return row(() => props.onEdit(kind));
  return (
    <MenuSubMenu>
      {row()}
      <Choices kind={kind} values={props.values} onChange={props.onChange} />
    </MenuSubMenu>
  );
}

const memberText = (
  kind: "owner" | "assignee",
  values: FilterValues,
  names: Map<string, string>,
) => {
  const id = values[kind] ?? (kind === "assignee" ? "me" : "anyone");
  if (id === "anyone") return "All";
  if (id === "me") return "Me";
  if (id === "none") return kind === "owner" ? "No owner" : "Unassigned";
  return names.get(id) ?? "–";
};

const rangeText = (from: string | null, to: string | null) =>
  from || to ? range(from, to) : "Any";

const money = (value: number | undefined) =>
  value === undefined ? null : formatMoney(value * 100, null);

const COMPANY_TEXT = { with: "Any", without: "None" } as const;

function useValueText(kind: FilterKind, values: FilterValues) {
  const owners = useOwners();
  const stages = useCrmStages().data ?? [];
  switch (kind) {
    case "owner":
    case "assignee":
      return memberText(kind, values, new Map(owners.map((o) => [o.id, o.name])));
    case "status":
      return values.status === "done" ? "Done" : "Open";
    case "company":
      return values.company ? COMPANY_TEXT[values.company] : "All";
    case "stage":
      return stages.find((s) => s.id === values.stage)?.name ?? "All";
    case "close":
      return rangeText(
        values.closeAfter ? shortDay(values.closeAfter) : null,
        values.closeBefore ? shortDay(values.closeBefore) : null,
      );
    case "value":
      return rangeText(money(values.minValue), money(values.maxValue));
    case "archived":
      return values.archived ? "Only" : "Hidden";
  }
}

type Choice = { id: string; label: string; mark?: ReactNode; patch: Patch };

function useChoices(kind: FilterKind) {
  const owners = useOwners();
  const selfId = useSelfMemberId();
  const stages = useCrmStages().data ?? [];
  const me = owners.find((owner) => owner.id === selfId);
  const self = me && <MemberAvatar name={me.name} image={me.image} />;
  const choices: Choice[] = choicesFor(kind, owners, stages, self);
  return choices;
}

function choicesFor(
  kind: FilterKind,
  owners: ReturnType<typeof useOwners>,
  stages: NonNullable<ReturnType<typeof useCrmStages>["data"]>,
  self: ReactNode,
) {
  const people = (key: "owner" | "assignee") =>
    owners.map((owner) => ({
      id: owner.id,
      label: owner.name,
      mark: <MemberAvatar name={owner.name} image={owner.image} />,
      patch: { [key]: owner.id },
    }));
  switch (kind) {
    case "owner":
      return [
        { id: "all", label: "All", mark: <EveryoneAvatar />, patch: { owner: undefined } },
        ...people("owner"),
        { id: "none", label: "No owner", mark: <NoMemberAvatar />, patch: { owner: "none" } },
      ];
    case "assignee":
      return [
        { id: "me", label: "Me", mark: self, patch: { assignee: undefined } },
        { id: "anyone", label: "All", mark: <EveryoneAvatar />, patch: { assignee: "anyone" } },
        ...people("assignee"),
        { id: "none", label: "Unassigned", mark: <NoMemberAvatar />, patch: { assignee: "none" } },
      ];
    case "status":
      return [
        { id: "open", label: "Open", patch: { status: undefined } },
        { id: "done", label: "Done", patch: { status: "done" } },
      ];
    case "company":
      return [
        { id: "all", label: "All", patch: { company: undefined } },
        { id: "with", label: "Any", patch: { company: "with" } },
        { id: "without", label: "None", patch: { company: "without" } },
      ];
    case "stage":
      return [
        { id: "all", label: "All", patch: { stage: undefined } },
        ...stages.map((stage) => ({ id: stage.id, label: stage.name, patch: { stage: stage.id } })),
      ];
    case "archived":
      return [
        { id: "hidden", label: "Hidden", patch: { archived: undefined } },
        { id: "only", label: "Only", patch: { archived: "only" } },
      ];
    default:
      return [];
  }
}

const chosenOf = (kind: FilterKind, values: FilterValues) => {
  switch (kind) {
    case "assignee":
      return values.assignee ?? "me";
    case "status":
      return values.status ?? "open";
    case "archived":
      return values.archived ?? "hidden";
    case "owner":
    case "company":
    case "stage":
      return values[kind] ?? "all";
    default:
      return "all";
  }
};

function Choices(props: {
  kind: FilterKind;
  values: FilterValues;
  onChange: (patch: Patch) => void;
}) {
  const choices = useChoices(props.kind);
  return (
    <Menu
      aria-label={LABELS[props.kind]}
      selectionMode="single"
      selectedKeys={[chosenOf(props.kind, props.values)]}
    >
      {choices.map((choice) => (
        <MenuItem
          key={choice.id}
          id={choice.id}
          textValue={choice.label}
          onAction={() => props.onChange(choice.patch)}
        >
          {choice.mark}
          <MenuLabel>{choice.label}</MenuLabel>
        </MenuItem>
      ))}
    </Menu>
  );
}
