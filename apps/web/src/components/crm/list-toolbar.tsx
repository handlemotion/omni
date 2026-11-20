import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
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
