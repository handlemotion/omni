import { useNavigate } from "@tanstack/react-router";
import { useCallback, type ReactNode } from "react";
import { IconColumns, IconRows } from "@/components/icons/central";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { CrmSort } from "@/lib/crm.ts";
import { FilterMenu, type FilterKind, type FilterValues } from "./list-filters.tsx";
import { SortControl, sortOf, sortParams, type SortState } from "./list-sort.tsx";

/** A list's view as the URL holds it: its sort and its filters. */
export type ListSearch = FilterValues & { sort?: CrmSort; dir?: "asc" | "desc" };

/** Writes `patch` into the URL's search, in place, so the view can be linked and reloaded. */
export function useSetListSearch() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Record<string, unknown>) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
        replace: true,
      }),
    [navigate],
  );
}

/** Filter, in the page header beside search. */
export function ListFilter(props: { search: ListSearch; filters: FilterKind[] }) {
  const set = useSetListSearch();
  return <FilterMenu kinds={props.filters} values={props.search} onChange={set} />;
}

/** The deals board's sort, in the header (a table sorts from its column headers). */
export function BoardSort(props: { search: ListSearch; sorts: CrmSort[] }) {
  const set = useSetListSearch();
  const sort = sortOf(props.search);
  return (
    <SortControl
      fields={props.sorts}
      value={props.sorts.includes(sort.sort) ? sort : { sort: "name", dir: "asc" }}
      onChange={(next: SortState) => set(sortParams(next))}
    />
  );
}

type ProjectsLayout = "board" | "table";

/** Board or Table, for Projects: the board unless the URL says table. */
export function ProjectsView(props: { search: { view?: ProjectsLayout } }) {
  const set = useSetListSearch();
  return (
    <ToggleGroup
      bare
      size="sq-xs"
      aria-label="Layout"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[props.search.view ?? "board"]}
      onSelectionChange={(keys) => {
        const [next] = [...keys];
        if (next === "board") set({ view: undefined });
        if (next === "table") set({ view: "table" });
      }}
    >
      <LayoutOption id="board" label="Board">
        <IconColumns />
      </LayoutOption>
      <LayoutOption id="table" label="Table">
        <IconRows />
      </LayoutOption>
    </ToggleGroup>
  );
}

function LayoutOption(props: { id: ProjectsLayout; label: string; children: ReactNode }) {
  return (
    <TooltipTrigger delay={400}>
      <ToggleGroupItem id={props.id} aria-label={props.label}>
        {props.children}
      </ToggleGroupItem>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}
