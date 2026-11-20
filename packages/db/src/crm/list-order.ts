import { asc, desc, sql, type AnyColumn, type SQL } from "drizzle-orm";

/** How a list is ordered. Deals add `value`, `closeOn`, `stageEntered`. */
export type CrmSortKey = "name" | "created" | "updated" | "value" | "closeOn" | "stageEntered";
export type CrmSortDir = "asc" | "desc";

export interface CrmSort {
  key: CrmSortKey;
  dir: CrmSortDir;
}

export const NAME_ASC: CrmSort = { key: "name", dir: "asc" };

/**
 * Where a page ended: the sort it was taken in, the last row's sort value and its id. A cursor
 * from another sort is ignored, so changing the sort starts from the top.
 */
export interface CrmListCursor {
  key: CrmSortKey;
  dir: CrmSortDir;
  /** The sort value as text: a name, an ISO time, a date, a whole number. Null sorts last. */
  value: string | null;
  id: string;
}

/** The column a sort key reads, and how its cursor value is cast back. */
export interface SortColumn {
  column: AnyColumn | SQL;
  /** `lower`: text compared lowercased, for names. */
  cast: "lower" | "text" | "timestamptz" | "date" | "bigint";
  /** Its value can be null; nulls go last in both directions. */
  nullable: boolean;
}

/**
 * The ordering, the keyset predicate after `cursor` and the cursor for a row, for one sort over
 * one table. Rows are ordered by the key, nulls last, then by id in the same direction.
 */
export function listOrder(
  sort: CrmSort,
  sortColumn: SortColumn,
  id: AnyColumn,
  cursor: CrmListCursor | null | undefined,
) {
  const { column, cast, nullable } = sortColumn;
  const by = sort.dir === "asc" ? asc : desc;
  const cmp = sort.dir === "asc" ? sql`>` : sql`<`;
  const orderBy = nullable
    ? [sql`${column} ${sql.raw(sort.dir)} nulls last`, by(id)]
    : [by(column), by(id)];
  const usable = cursor && cursor.key === sort.key && cursor.dir === sort.dir ? cursor : null;
  let after: SQL | undefined;
  if (usable && usable.value === null) {
    after = sql`(${column} is null and ${id} ${cmp} ${usable.id})`;
  } else if (usable) {
    const value =
      cast === "lower"
        ? sql`lower(cast(${usable.value} as text))`
        : sql`cast(${usable.value} as ${sql.raw(cast)})`;
    after = sql`((${column}, ${id}) ${cmp} (${value}, ${usable.id})${nullable ? sql` or ${column} is null` : sql``})`;
  }
  return { orderBy, after };
}

/** Cuts a page fetched with one extra row and gives the cursor after its last row. */
export function sortedPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sort: CrmSort,
  valueOf: (row: T) => string | number | Date | null,
) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (rows.length <= limit || !last) return { items, nextCursor: null };
  const raw = valueOf(last);
  const value = raw === null ? null : raw instanceof Date ? raw.toISOString() : String(raw);
  const nextCursor: CrmListCursor = { key: sort.key, dir: sort.dir, value, id: last.id };
  return { items, nextCursor };
}
