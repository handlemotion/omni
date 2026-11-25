import type { ReactNode } from "react";
import { SkeletonBox } from "skullet/react";
import { IconChevronRight } from "@/components/icons/central";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { SidebarItem, SidebarLabel, useSidebar } from "@/components/ui/sidebar";

const INDENT_PX = 16;

export function SidebarTreeRow(props: {
  href: string;
  isCurrent: boolean;
  depth: number;
  /** A section's own header (a Drive space): small muted text, no icon. */
  heading?: boolean;
  icon?: ReactNode;
  label: string;
  /** Trailing detail before the chevron (a count). */
  detail?: ReactNode;
  expand?: { value: boolean; toggle: () => void };
  /** Pressing the row itself, as it follows its link. */
  onPress?: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const rail = state === "collapsed" && !isMobile;
  if (rail && props.depth > 0) return null;
  const expand = rail ? undefined : props.expand;
  return (
    <div className="group/tree relative">
      <SidebarItem
        href={props.href}
        isCurrent={props.isCurrent}
        onPress={props.onPress}
        style={rail ? undefined : { paddingInlineStart: 8 + props.depth * INDENT_PX }}
        className={cn(
          props.heading && "text-label text-subtle-foreground hover:text-foreground",
          expand && "pe-8",
        )}
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
          className={cn(
            "absolute end-1 top-1 opacity-0 transition-opacity duration-150 group-hover/tree:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none",
            !props.heading && "aria-expanded:opacity-100",
          )}
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
