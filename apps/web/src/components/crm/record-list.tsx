// The CRM's lists (Companies, People, Deals), after Attio's record tables: Storage's frame (a
// 48px header with the title, then search and New 10px from the right edge) over the table's
// `page` variant, one 44px row per record, paged by the server's cursor as the table scrolls.
// The name leads each row with its mark; the other columns are muted, in tabular figures.
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { TableLoadMoreItem } from "react-aria-components/Table";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconPlus } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";

export const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export interface RecordColumn<T> {
  title: string;
  /** Its width; secondary columns leave on a phone with `max-sm:hidden`. */
  className: string;
  cell: (row: T) => ReactNode;
}

export interface RecordListSource<T> {
  rows: T[];
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
  hasNextPage: boolean;
  fetchNextPage: () => unknown;
  isFetchingNextPage: boolean;
}

/** A record's mark: its initial on a square (a company) or a disc (a person, a deal). */
export function RecordMark(props: { name: string; square?: boolean; size?: number }) {
  const size = props.size ?? 20;
  return (
    <Avatar
      isSquare={props.square}
      initials={props.name.trim().slice(0, 1).toUpperCase() || "?"}
      className="bg-secondary text-muted-foreground outline-0"
      style={{ "--avatar-size": `${size}px` } as React.CSSProperties}
    />
  );
}

/** A secondary value: muted, in tabular figures, an en dash when missing. */
export function Muted({ children }: { children: ReactNode }) {
  return (
    <span className="truncate text-muted-foreground tabular-nums">
      {children === null || children === undefined || children === "" ? "–" : children}
    </span>
  );
}

/**
 * The search box's text, written to the URL's `q` once typing pauses, so the list it filters can
 * be linked and survives a reload.
 */
export function useListSearch(q: string) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const settled = useDebouncedValue(text.trim(), 250);
  useEffect(() => {
    if (settled === q) return;
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, q: settled || undefined }),
      replace: true,
    });
    // Only a new settled text writes the URL; the URL changing (back, a link) leaves the box.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  return { text, setText };
}

export function RecordList<T extends { id: string; name: string }>(props: {
  title: string;
  /** "company": names the New button and the empty state. */
  noun: string;
  search: { text: string; setText: (text: string) => void; q: string };
  source: RecordListSource<T>;
  columns: RecordColumn<T>[];
  mark: (row: T) => ReactNode;
  href: (row: T) => string;
  onNew: () => void;
  /** Between the search and New: the deals' Board and List. */
  extra?: ReactNode;
  /** Shown under the header in place of the table (the deals' board). */
  replaceBody?: ReactNode;
}) {
  const phone = useIsMobile();
  return (
    <StorageFrame
      title={<Heading className="truncate text-md">{props.title}</Heading>}
      actions={
        <>
          {props.extra}
          <SearchField
            aria-label={`Search ${props.title.toLowerCase()}`}
            value={props.search.text}
            onChange={props.search.setText}
            className="w-40 sm:w-56"
          >
            <SearchInput size="sm" />
          </SearchField>
          <Button
            size={phone ? "sq-sm" : "sm"}
            aria-label={phone ? `New ${props.noun}` : undefined}
            onPress={props.onNew}
          >
            <IconPlus />
            {!phone && `New ${props.noun}`}
          </Button>
        </>
      }
    >
      {props.replaceBody ?? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Body {...props} />
        </div>
      )}
    </StorageFrame>
  );
}

function Body<T extends { id: string; name: string }>(props: Parameters<typeof RecordList<T>>[0]) {
  const { source } = props;
  if (source.isPending) {
    return (
      <Skeleton loading label={`Loading ${props.title.toLowerCase()}`} skeleton={<ListBones />}>
        {null}
      </Skeleton>
    );
  }
  if (source.isError) {
    return (
      <div className="flex h-full flex-col">
        <ListFailed retry={() => void source.refetch()} />
      </div>
    );
  }
  if (!source.rows.length) {
    return (
      <div className="flex h-full flex-col">
        {props.search.q ? (
          <EmptyState figure="loupe" title="Nothing matches" />
        ) : (
          <EmptyState figure="cabinet" title={`No ${props.title.toLowerCase()} yet`}>
            <Button size="sm" onPress={props.onNew}>
              New {props.noun}
            </Button>
          </EmptyState>
        )}
      </div>
    );
  }
  return (
    <Table variant="page" aria-label={props.title}>
      <TableHeader>
        <TableColumn isRowHeader>Name</TableColumn>
        {props.columns.map((column) => (
          <TableColumn key={column.title} className={column.className}>
            {column.title}
          </TableColumn>
        ))}
      </TableHeader>
      <TableBody>
        {source.rows.map((row) => (
          <TableRow key={row.id} id={row.id} textValue={row.name} href={props.href(row)}>
            <TableCell>
              <span className="flex min-w-0 items-center gap-3">
                {props.mark(row)}
                <span className="truncate">{row.name}</span>
              </span>
            </TableCell>
            {props.columns.map((column) => (
              <TableCell key={column.title} className={column.className}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
        <TableLoadMoreItem
          onLoadMore={source.hasNextPage ? () => void source.fetchNextPage() : undefined}
          isLoading={source.isFetchingNextPage}
        />
      </TableBody>
    </Table>
  );
}

/** The table while its rows load: skullet's boxes on the rows' own grid. */
function ListBones() {
  return (
    <div>
      <div className="h-9 border-b" />
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 border-b px-5">
          <SkeletonBox width={20} height={20} radius="999px" />
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${25 + ((i * 17) % 30)}%`} height={10} />
          </span>
          <span className="w-40 max-sm:hidden">
            <SkeletonBox width={88} height={10} />
          </span>
          <span className="w-32 max-sm:hidden">
            <SkeletonBox width={64} height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}
