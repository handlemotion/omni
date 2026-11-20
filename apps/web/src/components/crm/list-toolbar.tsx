import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import type { CrmSort } from "@/lib/crm.ts";
import {
  anyFilterSet,
  FilterChips,
  FilterMenu,
  type FilterKind,
  type FilterValues,
} from "./list-filters.tsx";
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

/**
 * The row under a list's header: the filters in use as chips, and the deals board's sort (a
 * table sorts from its column headers). Nothing at all while neither has anything to show.
 */
export function ListToolbar(props: {
  search: ListSearch;
  sorts?: CrmSort[];
  filters: FilterKind[];
}) {
  const set = useSetListSearch();
  const sort = sortOf(props.search);
  if (!props.sorts && !anyFilterSet(props.filters, props.search)) return null;
  return (
    <div
      role="toolbar"
      aria-label="View"
      className="flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto px-5"
    >
      {props.sorts && (
        <SortControl
          fields={props.sorts}
          value={props.sorts.includes(sort.sort) ? sort : { sort: "name", dir: "asc" }}
          onChange={(next: SortState) => set(sortParams(next))}
        />
      )}
      <FilterChips kinds={props.filters} values={props.search} onChange={set} />
    </div>
  );
}
