// The preview's tools on a small island under the stage: Mail's closed-sidebar island turned on
// its side (`sidebar-island.tsx`: the sidebar's fill and border, lines edge to edge between
// groups), kept small: 2px round 26px squares. On a PDF or an image, Cursor (just reading) and
// Comment (a target: a drag on the file opens the comment bar beside its box); on other files
// Comment opens the bar for the whole file over the island. Then the file's versions as
// "‹ v3 ›", whose label lists every version, and Restore while an older one is shown.
import { Fragment, type ReactNode } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClock3,
  IconCommentPlain,
  IconCursor,
  IconRestore,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

export interface RailVersion {
  /** "current", or the kept version's id. */
  key: string;
  /** "v3": counted from the oldest kept version. */
  label: string;
  writtenAt: string;
  writtenByName: string | null;
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function PreviewRail(props: {
  /** Comment shows `composer` over the island, for the whole file. */
  comment?:
    | { open: boolean; onToggle: () => void; isDisabled: boolean; composer: ReactNode }
    | undefined;
  /** Cursor, or Comment as a target on the file's pages. */
  target?: { on: boolean; onChange: (on: boolean) => void; isDisabled: boolean } | undefined;
  versions?:
    | {
        /** Newest first; the current content leads. */
        list: RailVersion[];
        shown: string;
        onShow: (key: string) => void;
        onRestore: () => void;
        restoring: boolean;
      }
    | undefined;
}) {
  const { comment, target } = props;
  const groups: ReactNode[] = [];
  if (comment || target) {
    groups.push(
      <>
        {target && (
          <>
            <Tool label="Cursor" pressed={!target.on} onPress={() => target.onChange(false)}>
              <IconCursor />
            </Tool>
            <Tool
              label="Comment"
              pressed={target.on}
              isDisabled={target.isDisabled}
              onPress={() => target.onChange(!target.on)}
            >
              <IconCommentPlain />
            </Tool>
          </>
        )}
        {comment && (
          <Tool
            label="Comment"
            pressed={comment.open}
            isDisabled={comment.isDisabled}
            onPress={comment.onToggle}
          >
            <IconCommentPlain />
          </Tool>
        )}
      </>,
    );
  }
  if (props.versions) groups.push(<Versions {...props.versions} />);
  if (groups.length === 0) return null;
  return (
    // In flow under the stage, on its fill, so it never covers the file's last lines. The comment
    // bar floats 8px over it, alone (no card around it), on the overlay shadow so it reads over the page.
    <div className="relative flex shrink-0 justify-center px-5 pb-2.5">
      {comment?.open && !comment.isDisabled && (
        <div className="absolute inset-x-5 bottom-full mx-auto mb-2 max-w-md rounded-[12px] shadow-(--shadow-overlay)">
          {comment.composer}
        </div>
      )}
      <div
        role="toolbar"
        aria-label="File tools"
        className="flex items-center gap-0.5 rounded-lg border border-sidebar-border bg-sidebar p-0.5"
      >
        {groups.map((group, index) => (
          <Fragment key={index}>
            {/* Top to bottom, through the island's 2px padding. */}
            {index > 0 && (
              <Separator
                orientation="vertical"
                className="-my-0.5 h-auto self-stretch bg-sidebar-border"
              />
            )}
            <div className="flex items-center">{group}</div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function Versions(props: NonNullable<Parameters<typeof PreviewRail>[0]["versions"]>) {
  const { list, shown } = props;
  const index = Math.max(
    0,
    list.findIndex((version) => version.key === shown),
  );
  const current = list[index];
  const older = list[index + 1];
  const newer = list[index - 1];
  return (
    <>
      <Tool
        label="Older version"
        isDisabled={!older}
        onPress={() => older && props.onShow(older.key)}
      >
        <IconChevronLeft />
      </Tool>
      <MenuTrigger>
        <Button
          intent="ghost"
          size="sq-xs"
          aria-label={`Version ${current?.label ?? ""}, choose a version`}
          className="w-auto min-w-7 px-1 text-xs tabular-nums"
        >
          {current?.label}
        </Button>
        <Menu
          // Out of the island: in place, an open menu could widen it.
          popover={{ container: document.body }}
          placement="top"
          aria-label="Versions"
          selectionMode="single"
          selectedKeys={[shown]}
          onAction={(key) => props.onShow(String(key))}
        >
          {list.map((version) => (
            <MenuItem key={version.key} id={version.key} textValue={version.label}>
              <IconClock3 data-slot="icon" />
              <MenuLabel className="tabular-nums">
                {version.label}
                {" · "}
                {WHEN.format(new Date(version.writtenAt))}
                {version.writtenByName ? ` · ${version.writtenByName}` : ""}
              </MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <Tool
        label="Newer version"
        isDisabled={!newer}
        onPress={() => newer && props.onShow(newer.key)}
      >
        <IconChevronRight />
      </Tool>
      {shown !== "current" && (
        <Tool label="Restore this version" isPending={props.restoring} onPress={props.onRestore}>
          <IconRestore />
        </Tool>
      )}
    </>
  );
}

function Tool(props: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  isPending?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-xs"
        aria-label={props.label}
        aria-pressed={props.pressed}
        isDisabled={props.isDisabled}
        isPending={props.isPending}
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}
