import type { MouseEvent, ReactNode } from "react";
import { Link } from "@/components/ui/link";

/** Where a row sits on the rail: the first row's line starts at its mark, the last row's ends there. */
export interface RailPlace {
  first: boolean;
  last: boolean;
}

/**
 * One row of a vertical rail, the Plan and Tasks tabs' shape: a date column on the left, a
 * spine with this row's mark on it, then the row itself. `opens` puts room above a row that
 * starts a group (a phase), with the spine carried through it. With `href` the whole row opens
 * it; the rail's other rows dim while one is hovered or `current`.
 */
export function RailRow(props: {
  date?: ReactNode;
  mark: ReactNode;
  place: RailPlace;
  opens?: boolean;
  href?: string;
  label?: string;
  current?: boolean;
  /** The row's right-click menu (`contextMenuProps`). */
  menu?: { onContextMenu: (event: MouseEvent) => void };
  children: ReactNode;
}) {
  const { first, last } = props.place;
  const lead = props.opens && !first ? "pt-4" : "";
  return (
    <li
      {...props.menu}
      data-current={props.current || undefined}
      className="relative grid min-w-0 grid-cols-[4rem_1.25rem_minmax(0,1fr)] gap-x-3 transition-opacity duration-150 ease-out group-has-[>li:hover]/rail:opacity-50 group-has-[>li[data-current]]/rail:opacity-50 hover:opacity-100! data-current:opacity-100! max-sm:grid-cols-[3.25rem_1.25rem_minmax(0,1fr)] max-sm:gap-x-2"
    >
      {props.href && (
        <Link
          href={props.href}
          aria-label={props.label}
          aria-current={props.current ? "true" : undefined}
          className="absolute inset-0 rounded-lg"
        />
      )}
      <span
        className={`pointer-events-none box-content flex h-10 items-center justify-start text-xs whitespace-nowrap tabular-nums ${lead}`}
      >
        {props.date}
      </span>
      <span className={`pointer-events-none relative flex justify-center ${lead}`}>
        {!(first && last) && (
          <span
            aria-hidden
            className={`absolute start-1/2 w-px -translate-x-1/2 bg-border ${
              first ? "top-5 bottom-0" : last ? (lead ? "top-0 h-9" : "top-0 h-5") : "inset-y-0"
            }`}
          />
        )}
        <span className="relative flex h-10 items-center">{props.mark}</span>
      </span>
      <div
        className={`min-w-0 ${props.href ? "pointer-events-none [&_[role=checkbox]]:pointer-events-auto [&_[role=dialog]]:pointer-events-auto [&_[role=menu]]:pointer-events-auto [&_button]:pointer-events-auto" : ""} ${lead}`}
      >
        {props.children}
      </div>
    </li>
  );
}

/** Splits a list into rail places, so the spine runs from the first mark to the last. */
export const railPlace = (index: number, count: number) =>
  ({ first: index === 0, last: index === count - 1 }) satisfies RailPlace;
