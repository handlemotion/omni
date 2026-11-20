import { useSearch } from "@tanstack/react-router";
import { createContext, use, type ReactNode } from "react";
import { BreadcrumbsItem } from "@/components/ui/breadcrumbs";
import { useCrmCompany, useCrmDeal, useCrmPerson } from "@/hooks/use-crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { CRM_LISTS } from "./crm-nav.tsx";

/**
 * The records a person went through to reach this one, so the header's crumbs follow their path
 * (Projects › a project › a person) instead of the record's own list. It rides in the URL as
 * `via=deals:<id>,people:<id>`, so a reload or a shared link keeps it.
 */
export type TrailKind = "companies" | "people" | "deals";
export interface TrailStep {
  kind: TrailKind;
  id: string;
}

const KINDS = new Set<string>(["companies", "people", "deals"]);
const MAX_STEPS = 4;

export function parseVia(via: string | undefined) {
  if (!via) return [] as TrailStep[];
  return via
    .split(",")
    .map((part) => {
      const at = part.indexOf(":");
      return { kind: part.slice(0, at), id: part.slice(at + 1) };
    })
    .filter((step): step is TrailStep => KINDS.has(step.kind) && step.id.length > 0)
    .slice(-MAX_STEPS);
}

const formatVia = (steps: TrailStep[]) => steps.map((step) => `${step.kind}:${step.id}`).join(",");

/** The path to `to`, through `steps`: going back to a record on the trail cuts the trail there. */
export function trailPath(steps: TrailStep[], to: TrailStep) {
  const back = steps.findIndex((step) => step.kind === to.kind && step.id === to.id);
  const before = (back === -1 ? steps : steps.slice(0, back)).slice(-MAX_STEPS);
  const path = `/crm/${to.kind}/${encodeURIComponent(to.id)}`;
  return before.length ? `${path}?via=${encodeURIComponent(formatVia(before))}` : path;
}

const TrailContext = createContext<TrailStep[]>([]);

export function useTrailVia() {
  const { via } = useSearch({ strict: false }) as { via?: string };
  return parseVia(via);
}

/** Around a record's page: links to other records from inside it carry the trail on. */
export function TrailProvider(props: { here: TrailStep; children: ReactNode }) {
  const via = useTrailVia();
  return <TrailContext value={[...via, props.here]}>{props.children}</TrailContext>;
}

/** The href to another record, carrying the trail that led here. */
export function useRecordHref() {
  const steps = use(TrailContext);
  const { href: inWorkspace } = useWorkspacePaths();
  return (kind: TrailKind, id: string) => inWorkspace(trailPath(steps, { kind, id }));
}

/** The crumbs before the record's own name: the first step's list, then each step by name. */
export function TrailCrumbs(props: { steps: TrailStep[]; fallback: keyof typeof CRM_LISTS }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const first = props.steps[0];
  return (
    <>
      {first ? <StepList step={first} /> : <ListCrumb list={props.fallback} />}
      {props.steps.map((step, i) => (
        <StepCrumb
          key={`${step.kind}:${step.id}`}
          step={step}
          href={inWorkspace(trailPath(props.steps.slice(0, i), step))}
        />
      ))}
    </>
  );
}

function ListCrumb({ list }: { list: keyof typeof CRM_LISTS }) {
  const { href: inWorkspace } = useWorkspacePaths();
  return (
    <BreadcrumbsItem className="shrink-0" href={inWorkspace(CRM_LISTS[list].path)}>
      {CRM_LISTS[list].label}
    </BreadcrumbsItem>
  );
}

function StepList({ step }: { step: TrailStep }) {
  if (step.kind === "deals") return <DealList id={step.id} />;
  return <ListCrumb list={step.kind} />;
}

function DealList({ id }: { id: string }) {
  const won = useCrmDeal(id).data?.deal.stageKind === "won";
  return <ListCrumb list={won ? "projects" : "deals"} />;
}

function StepCrumb(props: { step: TrailStep; href: string }) {
  switch (props.step.kind) {
    case "companies":
      return <CompanyCrumb id={props.step.id} href={props.href} />;
    case "people":
      return <PersonCrumb id={props.step.id} href={props.href} />;
    case "deals":
      return <DealCrumb id={props.step.id} href={props.href} />;
  }
}

function CompanyCrumb(props: { id: string; href: string }) {
  const name = useCrmCompany(props.id).data?.company.name;
  return <BreadcrumbsItem href={props.href}>{name ?? "…"}</BreadcrumbsItem>;
}

function PersonCrumb(props: { id: string; href: string }) {
  const name = useCrmPerson(props.id).data?.person.name;
  return <BreadcrumbsItem href={props.href}>{name ?? "…"}</BreadcrumbsItem>;
}

function DealCrumb(props: { id: string; href: string }) {
  const name = useCrmDeal(props.id).data?.deal.name;
  return <BreadcrumbsItem href={props.href}>{name ?? "…"}</BreadcrumbsItem>;
}
