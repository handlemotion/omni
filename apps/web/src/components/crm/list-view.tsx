import { useMemo, useState } from "react";
import type { CrmRecordKind } from "@/lib/crm.ts";
import { BulkBar } from "./bulk-bar.tsx";
import { sortOf, sortParams } from "./list-sort.tsx";
import { useSetListSearch, type ListSearch } from "./list-toolbar.tsx";
import type { RecordSelection } from "./record-list.tsx";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * A list's column sort and bulk selection. The selection belongs to one view: changing the sort,
 * a filter or the search drops it, and a row that leaves the list leaves it too.
 */
export function useListView(
  kind: CrmRecordKind,
  search: ListSearch & { q?: string },
  rows: { id: string }[],
) {
  const set = useSetListSearch();
  const viewKey = JSON.stringify(search);
  const [state, setState] = useState({ viewKey, keys: EMPTY });
  if (state.viewKey !== viewKey) setState({ viewKey, keys: EMPTY });
  const picked = state.viewKey === viewKey ? state.keys : EMPTY;
  const keys = useMemo(
    () => new Set(rows.filter((row) => picked.has(row.id)).map((row) => row.id)),
    [rows, picked],
  );
  const choose = (next: Iterable<string>) => setState({ viewKey, keys: new Set(next) });
  const selection: RecordSelection = {
    keys,
    onChange: choose,
    bar: (
      <BulkBar
        kind={kind}
        ids={[...keys]}
        archived={search.archived === "only"}
        onClear={() => choose([])}
      />
    ),
  };
  const sorting = {
    value: sortOf(search),
    onChange: (next: ReturnType<typeof sortOf>) => set(sortParams(next)),
  };
  return { selection, sorting };
}

/** True when anything narrows the list beyond the search. */
export const isFiltered = (search: ListSearch) =>
  [
    search.owner,
    search.company,
    search.stage,
    search.closeAfter,
    search.closeBefore,
    search.minValue,
    search.maxValue,
    search.archived,
  ].some((value) => value !== undefined);
