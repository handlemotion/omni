// The open file beside its folder, as an open thread sits beside the inbox: a 48px top bar (the
// name, cut in its middle, then Previous, Next, Download, the file's menu, Full screen and
// Close), the stage, and the file's details under it.
import type { ReactNode } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconMaximize,
  IconMinimize,
  IconX,
} from "@/components/icons/central";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { PageNav } from "@/components/shell/page-nav";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { TypeBadge } from "../file-glyph.tsx";
import { DAY } from "../file-table.tsx";
import { PreviewBody } from "./preview-body.tsx";

export function PreviewPanel(props: {
  node: StorageNode;
  url: string;
  /** The files before and after it in the folder, for Previous and Next. */
  previous: StorageNode | undefined;
  next: StorageNode | undefined;
  onOpen: (node: StorageNode) => void;
  onClose: () => void;
  onDownload: () => void;
  menu: SettingsRowMenuItem[];
  fullScreen: boolean;
  onFullScreen: () => void;
  /** False outside the app shell (a shared link's page): no sidebar toggle. */
  shell: boolean;
}) {
  const { node } = props;
  return (
    <section aria-label={node.name} className="flex min-w-0 flex-1 flex-col bg-background">
      {/* One row with the folder's header beside it: the same height and bottom line, 10px from
          the end as that header's actions are. */}
      <div
        className={`flex h-12 shrink-0 items-center gap-3 border-b pe-2.5 ${props.fullScreen ? "ps-2.5" : "border-s ps-5"}`}
      >
        {props.fullScreen && props.shell && <PageNav />}
        <Heading level={2} className="min-w-0 flex-1 text-md" title={node.name}>
          <MiddleTruncate text={node.name} />
        </Heading>
        <div className="flex shrink-0 items-center gap-1">
          <Action
            label="Previous"
            isDisabled={!props.previous}
            onPress={() => props.previous && props.onOpen(props.previous)}
          >
            <IconChevronLeft />
          </Action>
          <Action
            label="Next"
            isDisabled={!props.next}
            onPress={() => props.next && props.onOpen(props.next)}
          >
            <IconChevronRight />
          </Action>
          <Action label="Download" onPress={props.onDownload}>
            <IconDownload />
          </Action>
          <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} />
          <Action
            label={props.fullScreen ? "Side by side" : "Full screen"}
            onPress={props.onFullScreen}
          >
            {props.fullScreen ? <IconMinimize /> : <IconMaximize />}
          </Action>
          <Action label="Close" onPress={props.onClose}>
            <IconX />
          </Action>
        </div>
      </div>
      <div
        className={`flex min-h-0 flex-1 flex-col bg-surface ${props.fullScreen ? "" : "border-s"}`}
      >
        <PreviewBody node={node} url={props.url} onDownload={props.onDownload} />
      </div>
      <Details node={node} border={!props.fullScreen} />
    </section>
  );
}

/** Kind, size and dates, two columns under the stage. */
function Details(props: { node: StorageNode; border: boolean }) {
  const { node } = props;
  const rows: [string, ReactNode][] = [
    ["Kind", <TypeBadge key="kind" label={fileType(node.name, node.mimeType).label} />],
    ["Size", formatBytes(node.size)],
    ["Modified", DAY.format(new Date(node.updatedAt))],
    ["Created", DAY.format(new Date(node.createdAt))],
  ];
  return (
    <DescriptionList
      className={`shrink-0 grid-cols-[6rem_minmax(0,1fr)] border-t px-5 py-2 text-sm sm:grid-cols-[6rem_minmax(0,1fr)] sm:text-sm ${props.border ? "border-s" : ""}`}
    >
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <DescriptionTerm className="border-none py-1.5 sm:py-1.5">{term}</DescriptionTerm>
          <DescriptionDetails className="border-none py-1.5 tabular-nums sm:border-none sm:py-1.5">
            {value}
          </DescriptionDetails>
        </div>
      ))}
    </DescriptionList>
  );
}

function Action(props: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label={props.label}
        isDisabled={props.isDisabled}
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}
