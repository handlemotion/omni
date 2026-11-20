import { useState, type ReactNode } from "react";
import {
  IconArchive,
  IconBoard,
  IconBuildings,
  IconCalendar,
  IconFilter,
  IconMoney,
  IconUserMinus,
  IconUserRound,
  IconX,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { ButtonGroup } from "@/components/ui/button-group";
import { Menu, MenuItem, MenuLabel, MenuSubMenu, MenuTrigger } from "@/components/ui/menu";
import { useCrmStages, useOwners } from "@/hooks/use-crm.ts";
import { formatMoney } from "@/lib/crm.ts";
import { CloseDateDialog, ValueRangeDialog } from "./list-range-dialogs.tsx";
import { DAY } from "./record-list.tsx";

/** The filters a list offers, in the order its menu shows them. */
export type FilterKind = "owner" | "company" | "stage" | "close" | "value" | "archived";

/** A list's filters as the URL holds them. */
export interface FilterValues {
  owner?: string;
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
  company: { company: undefined },
  stage: { stage: undefined },
  close: { closeAfter: undefined, closeBefore: undefined },
  value: { minValue: undefined, maxValue: undefined },
  archived: { archived: undefined },
};

const LABELS: Record<FilterKind, string> = {
  owner: "Owner",
  company: "Company",
  stage: "Stage",
  close: "Close date",
  value: "Value",
  archived: "Archived",
};

const ICONS: Record<FilterKind, ReactNode> = {
  owner: <IconUserRound data-slot="icon" />,
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

/** True when any of `kinds` narrows the list, so its chips need a row. */
export const anyFilterSet = (kinds: FilterKind[], values: FilterValues) =>
  kinds.some((kind) => isSet(kind, values));

/** The set filters, each a chip that edits it and an X that clears it. */
export function FilterChips(props: FilterProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const shown = props.kinds.filter((kind) => isSet(kind, props.values));
  return (
    <>
      {shown.map((kind) => (
        <ButtonGroup key={kind}>
          <ChipValue
            kind={kind}
            values={props.values}
            onChange={props.onChange}
            onEdit={setEditing}
          />
          <Button
            intent="outline"
            size="sq-sm"
            aria-label={`Remove ${LABELS[kind]} filter`}
            onPress={() => props.onChange(CLEARS[kind])}
          >
            <IconX />
          </Button>
        </ButtonGroup>
      ))}
      <FilterDialogs {...props} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** Filter, in the page header: a menu of the filters not set yet. */
export function FilterMenu(props: FilterProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const phone = useIsMobile();
  const left = props.kinds.filter((kind) => !isSet(kind, props.values));
  if (!left.length) return null;
  return (
    <>
      <MenuTrigger>
        <Button
          intent="plain"
          size={phone ? "sq-sm" : "sm"}
          aria-label={phone ? "Filter" : undefined}
        >
          <IconFilter />
          {!phone && "Filter"}
        </Button>
        <Menu placement="bottom end" aria-label="Filter by">
          {left.map((kind) => (
            <FilterMenuEntry key={kind} kind={kind} onChange={props.onChange} onEdit={setEditing} />
          ))}
        </Menu>
      </MenuTrigger>
      <FilterDialogs {...props} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

type Editing = "close" | "value" | null;

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

function FilterMenuEntry(props: {
  kind: FilterKind;
  onChange: (patch: Patch) => void;
  onEdit: (kind: "close" | "value") => void;
}) {
  const { kind } = props;
  const row = (onAction?: () => void) => (
    <MenuItem id={kind} textValue={LABELS[kind]} onAction={onAction}>
      {ICONS[kind]}
      <MenuLabel>{LABELS[kind]}</MenuLabel>
    </MenuItem>
  );
  if (kind === "close" || kind === "value") return row(() => props.onEdit(kind));
  if (kind === "archived") return row(() => props.onChange({ archived: "only" }));
  return (
    <MenuSubMenu>
      {row()}
      <ChoiceMenu kind={kind} onChange={props.onChange} />
    </MenuSubMenu>
  );
}

function ChipValue(props: {
  kind: FilterKind;
  values: FilterValues;
  onChange: (patch: Patch) => void;
  onEdit: (kind: "close" | "value") => void;
}) {
  const { kind } = props;
  const text = useChipText(kind, props.values);
  const button = (onPress?: () => void) => (
    <Button intent="outline" size="sm" onPress={onPress} aria-label={`${LABELS[kind]}: ${text}`}>
      {ICONS[kind]}
      {kind !== "archived" && <span className="text-muted-foreground">{LABELS[kind]}</span>}
      <span className="max-w-40 truncate tabular-nums">{text}</span>
    </Button>
  );
  if (kind === "archived") return button();
  if (kind === "close" || kind === "value") return button(() => props.onEdit(kind));
  return (
    <MenuTrigger>
      {button()}
      <ChoiceMenu kind={kind} onChange={props.onChange} />
    </MenuTrigger>
  );
}

function useChipText(kind: FilterKind, values: FilterValues) {
  const owners = useOwners();
  const stages = useCrmStages().data ?? [];
  switch (kind) {
    case "owner":
      return values.owner === "none"
        ? "No owner"
        : (owners.find((o) => o.id === values.owner)?.name ?? "–");
    case "company":
      return values.company === "with" ? "Any" : "None";
    case "stage":
      return stages.find((s) => s.id === values.stage)?.name ?? "–";
    case "close":
      return range(
        values.closeAfter ? shortDay(values.closeAfter) : null,
        values.closeBefore ? shortDay(values.closeBefore) : null,
      );
    case "value":
      return range(
        values.minValue === undefined ? null : formatMoney(values.minValue * 100, null),
        values.maxValue === undefined ? null : formatMoney(values.maxValue * 100, null),
      );
    case "archived":
      return "Archived";
  }
}

function ChoiceMenu(props: { kind: FilterKind; onChange: (patch: Patch) => void }) {
  const owners = useOwners();
  const stages = useCrmStages().data ?? [];
  if (props.kind === "owner") {
    return (
      <Menu placement="bottom start" aria-label="Owner">
        <MenuItem id="none" textValue="No owner" onAction={() => props.onChange({ owner: "none" })}>
          <IconUserMinus data-slot="icon" />
          <MenuLabel>No owner</MenuLabel>
        </MenuItem>
        {owners.map((owner) => (
          <MenuItem
            key={owner.id}
            id={owner.id}
            textValue={owner.name}
            onAction={() => props.onChange({ owner: owner.id })}
          >
            <Avatar src={owner.image} initials={owner.name.slice(0, 1)} />
            <MenuLabel>{owner.name}</MenuLabel>
          </MenuItem>
        ))}
      </Menu>
    );
  }
  if (props.kind === "company") {
    return (
      <Menu placement="bottom start" aria-label="Company">
        <MenuItem id="with" textValue="Any" onAction={() => props.onChange({ company: "with" })}>
          <IconBuildings data-slot="icon" />
          <MenuLabel>Any</MenuLabel>
        </MenuItem>
        <MenuItem
          id="without"
          textValue="None"
          onAction={() => props.onChange({ company: "without" })}
        >
          <IconX data-slot="icon" />
          <MenuLabel>None</MenuLabel>
        </MenuItem>
      </Menu>
    );
  }
  return (
    <Menu placement="bottom start" aria-label="Stage">
      {stages.map((stage) => (
        <MenuItem
          key={stage.id}
          id={stage.id}
          textValue={stage.name}
          onAction={() => props.onChange({ stage: stage.id })}
        >
          <IconBoard data-slot="icon" />
          <MenuLabel>{stage.name}</MenuLabel>
        </MenuItem>
      ))}
    </Menu>
  );
}
