import { useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Breadcrumbs, BreadcrumbsItem } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api.ts";
import { CRM_LISTS } from "./crm-nav.tsx";
import type { SenderLogoFor } from "@/lib/sender-logo";
import { RecordMark } from "./record-list.tsx";
import {
  TrailCrumbs,
  TrailProvider,
  useRecordHref,
  useTrailVia,
  type TrailStep,
} from "./record-trail.tsx";

export interface RecordTab {
  id: string;
  label: string;
  panel: ReactNode;
}

const DETAILS_WIDTH = 384;
const DETAILS_MIN = 300;
const DETAILS_MAX = 600;

export function RecordLayout(props: {
  list: keyof typeof CRM_LISTS;
  /** The record on the page: the crumbs and its links to other records carry it on. */
  here: TrailStep;
  name: string;
  /** A company's mark is square. */
  square?: boolean;
  /** Whose logo or picture the mark shows. */
  who?: SenderLogoFor | null;
  /** A line under the name: a person's title, a deal's client. */
  subtitle?: ReactNode;
  /** After the name: a deal's stage, Archived. */
  badge?: ReactNode;
  actions?: ReactNode;
  details: ReactNode;
  tabs: RecordTab[];
}) {
  const details = useStoredWidth("omni:crm-details-width", DETAILS_WIDTH, DETAILS_MIN, DETAILS_MAX);
  const [resizing, setResizing] = useState(false);
  return (
    <TrailProvider here={props.here}>
      <RecordFrame list={props.list} name={props.name} actions={props.actions}>
        <div
          className={`flex min-h-0 flex-1 overflow-y-auto max-lg:flex-col lg:overflow-hidden ${resizing ? "cursor-ew-resize select-none" : ""}`}
          style={{ "--details-width": `${details.width}px` } as React.CSSProperties}
        >
          <aside
            aria-label="Details"
            className="flex shrink-0 flex-col gap-6 px-5 py-5 lg:w-(--details-width) lg:overflow-y-auto lg:border-e"
          >
            <div className="flex min-w-0 items-center gap-3">
              <RecordMark name={props.name} square={props.square} who={props.who} size={40} />
              <div className="flex min-w-0 flex-col">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate text-md text-foreground">{props.name}</h2>
                  {props.badge && (
                    <span className="flex shrink-0 items-center gap-1.5">{props.badge}</span>
                  )}
                </div>
                {props.subtitle && (
                  <span className="truncate text-xs/4 text-muted-foreground">{props.subtitle}</span>
                )}
              </div>
            </div>
            {props.details}
          </aside>
          <main className="relative min-w-0 flex-1 pb-4 lg:overflow-y-auto">
            <ResizeGrip
              label="Resize details"
              className="max-lg:hidden"
              width={() => details.width}
              onResize={details.set}
              onReset={details.reset}
              onResizingChange={setResizing}
            />
            <Tabs className="w-full">
              <TabList aria-label="Record" className="px-5 pt-2">
                {props.tabs.map((tab) => (
                  <Tab key={tab.id} id={tab.id}>
                    {tab.label}
                  </Tab>
                ))}
              </TabList>
              {props.tabs.map((tab) => (
                <TabPanel key={tab.id} id={tab.id} className="px-5 pt-2">
                  {tab.panel}
                </TabPanel>
              ))}
            </Tabs>
          </main>
        </div>
      </RecordFrame>
    </TrailProvider>
  );
}

/** The header: the list it belongs to, then its name, and the page's actions. */
export function RecordFrame(props: {
  list: keyof typeof CRM_LISTS;
  name: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const steps = useTrailVia();
  return (
    <StorageFrame
      title={
        <Breadcrumbs aria-label="Record" size="lg">
          <TrailCrumbs steps={steps} fallback={props.list} />
          {props.name !== null && <BreadcrumbsItem>{props.name}</BreadcrumbsItem>}
        </Breadcrumbs>
      }
      actions={props.actions}
      bordered
    >
      {props.children}
    </StorageFrame>
  );
}

/** A group in the left pane: the record's fields (untitled), then People, Deals. */
export function DetailSection(props: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      {props.title && (
        <div className="flex h-7 items-center justify-between">
          <h3 className="text-sm text-muted-foreground">{props.title}</h3>
          {props.action}
        </div>
      )}
      <div className="flex flex-col gap-0.5">{props.children}</div>
    </section>
  );
}

/** A related record in a section: its mark and name, linking to its page, and a value after. */
export function RelatedRow(props: {
  kind: "companies" | "people" | "deals";
  id: string;
  name: string;
  who?: SenderLogoFor | null;
  meta?: ReactNode;
  /** Shown over the name on hover (a person's role), so the name keeps the row's width. */
  hint?: string | null;
}) {
  const recordHref = useRecordHref();
  return (
    <Link
      href={recordHref(props.kind, props.id)}
      className="-mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors duration-150 ease-out hover:bg-hover"
    >
      <RecordMark name={props.name} square={props.kind === "companies"} who={props.who} size={18} />
      {props.hint ? (
        <TooltipTrigger>
          <span className="min-w-0 flex-1 truncate">{props.name}</span>
          <Tooltip placement="top start">{props.hint}</Tooltip>
        </TooltipTrigger>
      ) : (
        <span className="min-w-0 flex-1 truncate">{props.name}</span>
      )}
      {props.meta && (
        <span className="shrink-0 truncate text-xs text-muted-foreground tabular-nums">
          {props.meta}
        </span>
      )}
    </Link>
  );
}

/** Nothing related yet: an en dash where the rows would be. */
export function NoneRow() {
  return <span className="flex h-8 items-center text-sm text-muted-foreground">–</span>;
}

/** While the record loads, or when it failed or is gone. */
export function RecordState(props: {
  list: keyof typeof CRM_LISTS;
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
}) {
  if (props.query.isPending) {
    return (
      <RecordFrame list={props.list} name={null}>
        <Skeleton loading label="Loading" skeleton={<RecordBones />}>
          {null}
        </Skeleton>
      </RecordFrame>
    );
  }
  const gone = props.query.error instanceof ApiError && props.query.error.status === 404;
  return (
    <RecordFrame list={props.list} name={null}>
      <div className="flex h-full flex-col">
        {gone ? (
          <EmptyState figure="loupe" title="This record is gone" />
        ) : (
          <EmptyState figure="plug" title="This record didn't load">
            <Button size="sm" intent="outline" onPress={() => void props.query.refetch()}>
              Try again
            </Button>
          </EmptyState>
        )}
      </div>
    </RecordFrame>
  );
}

function RecordBones() {
  return (
    <div className="flex gap-0 max-lg:flex-col">
      <div className="flex flex-col gap-4 px-5 py-5 lg:w-(--details-width,384px)">
        <div className="flex items-center gap-3">
          <SkeletonBox width={40} height={40} radius="999px" />
          <SkeletonBox width={140} height={12} />
        </div>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <SkeletonBox width={72} height={10} />
            <SkeletonBox width={`${40 + ((i * 11) % 30)}%`} height={10} />
          </div>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-5 px-5 py-6">
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonBox key={i} width={`${35 + ((i * 13) % 40)}%`} height={10} />
        ))}
      </div>
    </div>
  );
}
