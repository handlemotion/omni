import type { ReactNode } from "react";
import { TableLoadMoreItem } from "react-aria-components/Table";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconPlus } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { StorageFrame } from "@/components/storage/storage-frame";
import { SenderAvatar } from "@/components/avatar/sender-avatar";
import type { SenderLogoFor } from "@/lib/sender-logo";
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

/**
 * A record's mark on a square (a company) or a disc (a person, a deal): the company's logo or the
 * person's picture when `who` finds one, otherwise its initial.
 */
export function RecordMark(props: {
  name: string;
  square?: boolean;
  size?: number;
  who?: SenderLogoFor | null;
}) {
  const size = props.size ?? 20;
  return (
    <SenderAvatar
      who={props.who ?? null}
      name={props.name}
      isSquare={props.square}
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

export { useListSearch } from "@/hooks/use-list-search.ts";

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
