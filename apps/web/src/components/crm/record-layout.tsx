import type { ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Breadcrumbs, BreadcrumbsItem } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api.ts";
import { CRM_LISTS } from "./crm-nav.tsx";
import type { SenderLogoFor } from "@/lib/sender-logo";
import { RecordMark } from "./record-list.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

export interface RecordTab {
  id: string;
  label: string;
  panel: ReactNode;
}

export function RecordLayout(props: {
  list: keyof typeof CRM_LISTS;
  name: string;
  /** A company's mark is square. */
  square?: boolean;
  /** Whose logo or picture the mark shows. */
  who?: SenderLogoFor | null;
  /** A line under the name: a person's title, a deal's stage. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  details: ReactNode;
  tabs: RecordTab[];
}) {
  return (
    <RecordFrame list={props.list} name={props.name} actions={props.actions}>
      <div className="flex min-h-0 flex-1 overflow-y-auto max-lg:flex-col lg:overflow-hidden">
        <aside
          aria-label="Details"
          className="flex shrink-0 flex-col gap-6 px-5 py-5 lg:w-80 lg:overflow-y-auto lg:border-e"
        >
          <div className="flex min-w-0 items-center gap-3">
            <RecordMark name={props.name} square={props.square} who={props.who} size={32} />
            <div className="flex min-w-0 flex-col">
              <h2 className="truncate text-md text-foreground">{props.name}</h2>
              {props.subtitle && (
                <span className="truncate text-xs/4 text-muted-foreground">{props.subtitle}</span>
              )}
            </div>
          </div>
          {props.details}
        </aside>
        <main className="min-w-0 flex-1 px-5 py-4 lg:overflow-y-auto">
          <Tabs className="w-full">
            <TabList aria-label="Record">
              {props.tabs.map((tab) => (
                <Tab key={tab.id} id={tab.id}>
                  {tab.label}
                </Tab>
              ))}
            </TabList>
            {props.tabs.map((tab) => (
              <TabPanel key={tab.id} id={tab.id} className="pt-2">
                {tab.panel}
              </TabPanel>
            ))}
          </Tabs>
        </main>
      </div>
    </RecordFrame>
  );
}

/** The header: the list it belongs to, then its name, and the page's actions. */
export function RecordFrame(props: {
  list: keyof typeof CRM_LISTS;
  name: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { href: inWorkspace } = useWorkspacePaths();
  const list = CRM_LISTS[props.list];
  return (
    <StorageFrame
      title={
        <Breadcrumbs aria-label="Record" size="lg">
          <BreadcrumbsItem className="shrink-0" href={inWorkspace(list.path)}>
            {list.label}
          </BreadcrumbsItem>
          {props.name !== null && <BreadcrumbsItem>{props.name}</BreadcrumbsItem>}
        </Breadcrumbs>
      }
      actions={props.actions}
    >
      {props.children}
    </StorageFrame>
  );
}

/** A titled group in the left pane: Details, People, Deals. */
export function DetailSection(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-7 items-center justify-between">
        <h3 className="text-sm text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
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
}) {
  const { href: inWorkspace } = useWorkspacePaths();
  return (
    <Link
      href={inWorkspace(`/crm/${props.kind}/${encodeURIComponent(props.id)}`)}
      className="-mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors duration-150 ease-out hover:bg-hover"
    >
      <RecordMark name={props.name} square={props.kind === "companies"} who={props.who} size={18} />
      <span className="min-w-0 flex-1 truncate">{props.name}</span>
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
      <div className="flex flex-col gap-4 px-5 py-5 lg:w-80">
        <div className="flex items-center gap-3">
          <SkeletonBox width={32} height={32} radius="999px" />
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
