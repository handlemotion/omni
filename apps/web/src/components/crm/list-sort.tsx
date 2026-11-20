import type { ReactNode } from "react";
import type { SortDescriptor } from "react-aria-components/Table";
import {
  IconArrowDown,
  IconArrowUp,
  IconBoard,
  IconCalendar,
  IconClock3,
  IconMoney,
  IconPlus,
  IconText,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import type { CrmSort } from "@/lib/crm.ts";
import { SORT_START_DIR } from "@/lib/crm-lists.ts";

type Dir = "asc" | "desc";

/** Each sortable field: its label, its icon, and the direction it starts in. */
export const SORT_FIELDS: Record<CrmSort, { label: string; icon: ReactNode; dir: Dir }> = {
  name: { label: "Name", icon: <IconText data-slot="icon" />, dir: SORT_START_DIR.name },
  created: { label: "Created", icon: <IconPlus data-slot="icon" />, dir: SORT_START_DIR.created },
  updated: { label: "Updated", icon: <IconClock3 data-slot="icon" />, dir: SORT_START_DIR.updated },
  value: { label: "Value", icon: <IconMoney data-slot="icon" />, dir: SORT_START_DIR.value },
  closeOn: {
    label: "Close date",
    icon: <IconCalendar data-slot="icon" />,
    dir: SORT_START_DIR.closeOn,
  },
  stageEntered: {
    label: "Stage entered",
    icon: <IconBoard data-slot="icon" />,
    dir: SORT_START_DIR.stageEntered,
  },
};

export interface SortState {
  sort: CrmSort;
  dir: Dir;
}

/** The URL's sort, with the list's default (name, A to Z) filled in. */
export const sortOf = (search: { sort?: CrmSort; dir?: Dir }) =>
  ({
    sort: search.sort ?? "name",
    dir: search.dir ?? (search.sort ? SORT_FIELDS[search.sort].dir : "asc"),
  }) satisfies SortState;

/** The URL params for a sort: the default leaves them out. */
export const sortParams = (next: SortState) =>
  next.sort === "name" && next.dir === "asc"
    ? { sort: undefined, dir: undefined }
    : { sort: next.sort, dir: next.dir };

/** A table's column sort, as React Aria's `sortDescriptor` reads it. */
export const descriptorOf = (state: SortState) =>
  ({
    column: state.sort,
    direction: state.dir === "asc" ? "ascending" : "descending",
  }) satisfies SortDescriptor;

/** A table header press: the same field flips its direction, a new one starts in its own. */
export const fromDescriptor = (descriptor: SortDescriptor, current: SortState) => {
  const sort = String(descriptor.column) as CrmSort;
  const dir: Dir =
    sort !== current.sort
      ? SORT_FIELDS[sort].dir
      : descriptor.direction === "ascending"
        ? "asc"
        : "desc";
  return { sort, dir } satisfies SortState;
};

/** The field menu, then a button that flips the direction. */
export function SortControl(props: {
  fields: CrmSort[];
  value: SortState;
  onChange: (next: SortState) => void;
}) {
  const field = SORT_FIELDS[props.value.sort];
  const ascending = props.value.dir === "asc";
  return (
    <ButtonGroup>
      <MenuTrigger>
        <Button intent="outline" size="sm" aria-label={`Sort by ${field.label}`}>
          {field.icon}
          {field.label}
        </Button>
        <Menu
          placement="bottom start"
          aria-label="Sort by"
          selectionMode="single"
          selectedKeys={[props.value.sort]}
        >
          {props.fields.map((id) => (
            <MenuItem
              key={id}
              id={id}
              textValue={SORT_FIELDS[id].label}
              onAction={() =>
                id !== props.value.sort && props.onChange({ sort: id, dir: SORT_FIELDS[id].dir })
              }
            >
              {SORT_FIELDS[id].icon}
              <MenuLabel>{SORT_FIELDS[id].label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <Button
        intent="outline"
        size="sq-sm"
        aria-label={ascending ? "Ascending" : "Descending"}
        onPress={() => props.onChange({ ...props.value, dir: ascending ? "desc" : "asc" })}
      >
        {ascending ? <IconArrowUp /> : <IconArrowDown />}
      </Button>
    </ButtonGroup>
  );
}
