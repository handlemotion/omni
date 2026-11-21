import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";
import {
  useCrmCompany,
  useCrmDefaultCurrency,
  useCrmStages,
  useUpdateCompany,
} from "@/hooks/use-crm.ts";
import { formatMoney, lastContactedAt, valueCurrency, type CrmDeal } from "@/lib/crm.ts";
import { Contracts } from "./contracts.tsx";
import { CreateMenu } from "./create-menu.tsx";
import { crmErrorToast } from "./crm-errors.ts";
import { StageBadge } from "./list-pages.tsx";
import { OwnerValue } from "./record-pages.tsx";
import { NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import { ArchivedBadge, RecordActions } from "./record-actions.tsx";
import { AddDomainDialog } from "./record-dialogs.tsx";
import { PlainValue, TextValue } from "./record-fields.tsx";
import { RecordFiles } from "./record-files.tsx";
import { DetailSection, RecordFrame, RecordState } from "./record-layout.tsx";
import { DAY, RecordMark } from "./record-list.tsx";
import { AddButton, DomainsSection, PeopleSection } from "./record-sections.tsx";
import { TrailProvider, useRecordHref } from "./record-trail.tsx";
import { RecordTasks } from "./tasks.tsx";
import { Timeline } from "./timeline.tsx";

/**
 * A client (a company) as one stacked page, so it reads apart from a person's or a deal's split
 * page: the client's own head, owner and deals stacked in a centred column with its timeline,
 * tasks, files and contracts under them, and its fields in a narrow pane on the right.
 */
export function CompanyPage({ id }: { id: string }) {
  const query = useCrmCompany(id);
  const update = useUpdateCompany();
  const [open, setOpen] = useState<"person" | "deal" | "domain" | null>(null);
  const close = () => setOpen(null);
  const { task } = useSearch({ strict: false }) as { task?: string };
  if (!query.data) return <RecordState list="companies" query={query} />;
  const { company, domains, people, deals } = query.data;
  const save = (change: {
    name?: string;
    description?: string | null;
    ownerMemberId?: string | null;
  }) =>
    update.mutate(
      { id, ...change },
      { onError: (error) => crmErrorToast(error, "The company was not changed") },
    );
  const archived = !!company.archivedAt;
  const added = DAY.format(new Date(company.createdAt));
  const contacted = lastContactedAt(company);
  return (
    <TrailProvider here={{ kind: "companies", id }}>
      <RecordFrame
        list="companies"
        name={company.name}
        actions={
          <>
            <CreateMenu record={{ kind: "companies", id, name: company.name }} />
            <RecordActions kind="companies" id={id} name={company.name} archived={archived} />
          </>
        }
      >
        <div className="flex min-h-0 flex-1 overflow-y-auto max-lg:flex-col lg:overflow-hidden">
          <main className="min-w-0 flex-1 lg:overflow-y-auto">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 pt-8 pb-12">
              <ClientHead
                name={company.name}
                domain={domains[0] ?? null}
                description={company.description}
                badge={archived && <ArchivedBadge />}
              />
              <ClientDeals
                deals={deals}
                domain={domains[0] ?? null}
                onAdd={() => setOpen("deal")}
              />
              <Tabs className="w-full" defaultSelectedKey={task ? "tasks" : undefined}>
                <TabList
                  aria-label="Client"
                  className="sticky top-0 z-10 bg-background pt-1.5 [--tab-list-pb:--spacing(1.5)]"
                >
                  <Tab id="timeline">Timeline</Tab>
                  <Tab id="tasks">Tasks</Tab>
                  <Tab id="files">Files</Tab>
                  <Tab id="contracts">Contracts</Tab>
                </TabList>
                <TabPanel id="timeline" className="flex flex-col pt-4">
                  <Timeline kind="companies" id={id} />
                </TabPanel>
                <TabPanel id="tasks" className="flex flex-col pt-4">
                  <RecordTasks kind="companies" id={id} />
                </TabPanel>
                <TabPanel id="files" className="flex flex-col pt-2">
                  <RecordFiles
                    kind="companies"
                    id={id}
                    name={company.name}
                    folderId={company.folderNodeId}
                  />
                </TabPanel>
                <TabPanel id="contracts" className="flex flex-col pt-4">
                  <Contracts owner={{ companyId: id }} folderId={company.folderNodeId} />
                </TabPanel>
              </Tabs>
            </div>
          </main>
          <aside
            aria-label="Details"
            className="flex shrink-0 flex-col gap-6 px-5 py-5 max-lg:border-t lg:w-80 lg:overflow-y-auto lg:border-s"
          >
            <DetailSection title="Details">
              <TextValue
                label="Name"
                required
                value={company.name}
                onSave={(name) => name && save({ name })}
              />
              <TextValue
                label="Description"
                maxLength={2000}
                value={company.description}
                onSave={(description) => save({ description })}
              />
              <OwnerValue
                value={company.ownerMemberId}
                onSave={(ownerMemberId) => save({ ownerMemberId })}
              />
              <PlainValue label="Last contacted">
                {contacted ? DAY.format(new Date(contacted)) : null}
              </PlainValue>
              <PlainValue label="Added">{added}</PlainValue>
            </DetailSection>
            <DomainsSection companyId={id} domains={domains} onAdd={() => setOpen("domain")} />
            <PeopleSection people={people} onAdd={() => setOpen("person")} />
          </aside>
        </div>
      </RecordFrame>
      {open === "person" && <NewPersonDialog companyId={id} onClose={close} />}
      {open === "deal" && <NewDealDialog companyId={id} onClose={close} />}
      {open === "domain" && <AddDomainDialog companyId={id} onClose={close} />}
    </TrailProvider>
  );
}

function ClientHead(props: {
  name: string;
  domain: string | null;
  description: string | null;
  badge: ReactNode;
}) {
  return (
    <header className="flex min-w-0 items-start gap-4">
      <RecordMark
        name={props.name}
        square
        who={props.domain ? { domain: props.domain } : null}
        size={48}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          <h1 className="truncate text-lg text-foreground">{props.name}</h1>
          {props.badge && <span className="flex shrink-0">{props.badge}</span>}
        </div>
        {props.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{props.description}</p>
        )}
        {props.domain && <CopyDomain domain={props.domain} />}
      </div>
    </header>
  );
}

function CopyDomain({ domain }: { domain: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    await navigator.clipboard.writeText(domain);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate text-sm text-muted-foreground">{domain}</span>
      <TooltipTrigger delay={300}>
        <Button
          intent="plain"
          size="sq-2xs"
          aria-label={`Copy ${domain}`}
          className="text-muted-foreground hover:text-foreground"
          onPress={() => void copy()}
        >
          {copied ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}
        </Button>
        <Tooltip arrow={false}>{copied ? "Copied" : "Copy"}</Tooltip>
      </TooltipTrigger>
    </div>
  );
}

function ClientDeals(props: { deals: CrmDeal[]; domain: string | null; onAdd: () => void }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Deals">
      <div className="flex h-7 items-center justify-between">
        <h2 className="text-sm text-foreground">
          Deals{" "}
          <span className="text-subtle-foreground tabular-nums">{props.deals.length || ""}</span>
        </h2>
        <AddButton label="Add deal" onPress={props.onAdd} />
      </div>
      {props.deals.length ? (
        <ul className="flex flex-col gap-2">
          {props.deals.map((deal) => (
            <li key={deal.id}>
              <DealCard deal={deal} domain={props.domain} />
            </li>
          ))}
        </ul>
      ) : (
        <span className="flex h-8 items-center text-sm text-muted-foreground">–</span>
      )}
    </section>
  );
}

function DealCard({ deal, domain }: { deal: CrmDeal; domain: string | null }) {
  const recordHref = useRecordHref();
  const stage = (useCrmStages().data ?? []).find((s) => s.id === deal.stageId);
  const currency = valueCurrency(deal.valueCurrency, useCrmDefaultCurrency());
  const value = deal.valueMinor == null ? null : formatMoney(deal.valueMinor, currency);
  return (
    <Link
      href={recordHref("deals", deal.id)}
      className="flex min-w-0 items-center gap-3 rounded-lg border bg-background px-4 py-3 transition-colors duration-150 ease-out hover:bg-hover"
    >
      <RecordMark
        name={deal.name}
        square
        size={32}
        src={deal.iconUrl}
        who={domain ? { domain } : null}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm text-foreground">{deal.name}</span>
        {value && (
          <span className="truncate text-xs text-muted-foreground tabular-nums">{value}</span>
        )}
      </div>
      <StageBadge stage={stage} deal={deal} />
    </Link>
  );
}
