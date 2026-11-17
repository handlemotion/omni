// A row of a sidebar tree (Drive's folders and files, the CRM's companies and deals), in the
// sidebar's own row: its glyph and label, stepped in 16px a level, so a child's glyph sits under
// its parent's name. A row that opens has a chevron at its end, shown on the row's hover and
// while open (always for keyboard and touch); the row and its chevron are siblings, since a button
// can't sit inside a link.
import type { ReactNode } from "react";
import { SkeletonBox } from "skullet/react";
import { IconChevronRight } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { SidebarItem, SidebarLabel } from "@/components/ui/sidebar";

const INDENT_PX = 16;

export function SidebarTreeRow(props: {
  href: string;
  isCurrent: boolean;
  depth: number;
  icon: ReactNode;
  label: string;
  /** Trailing detail before the chevron (a count). */
  detail?: ReactNode;
  expand?: { value: boolean; toggle: () => void };
  /** Pressing the row itself, as it follows its link. */
  onPress?: () => void;
}) {
  const { expand } = props;
  return (
    <div className="group/tree relative">
      <SidebarItem
        href={props.href}
        isCurrent={props.isCurrent}
        onPress={props.onPress}
        style={{ paddingInlineStart: 8 + props.depth * INDENT_PX }}
        className={expand ? "pe-8" : undefined}
      >
        {props.icon}
        <SidebarLabel>{props.label}</SidebarLabel>
        {props.detail !== undefined && (
          <span className="ms-auto shrink-0 text-xs text-subtle-foreground tabular-nums">
            {props.detail}
          </span>
        )}
      </SidebarItem>
      {expand && (
        <Button
          intent="plain"
          size="sq-xs"
          aria-label={`${expand.value ? "Collapse" : "Expand"} ${props.label}`}
          aria-expanded={expand.value}
          onPress={expand.toggle}
          className="absolute end-1 top-1 opacity-0 transition-opacity duration-150 group-hover/tree:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
        >
          <IconChevronRight
            className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${expand.value ? "rotate-90" : ""}`}
          />
        </Button>
      )}
    </div>
  );
}

/** A level's rows while they load. */
export function SidebarTreeBones(props: { depth: number }) {
  return (
    <div style={{ paddingInlineStart: 8 + props.depth * INDENT_PX }}>
      {[55, 40, 65].map((width) => (
        <div key={width} className="flex h-8 items-center gap-2.5">
          <SkeletonBox width={15} height={15} radius="var(--radius-sm)" />
          <SkeletonBox width={`${width}%`} height={8} />
        </div>
      ))}
    </div>
  );
}
