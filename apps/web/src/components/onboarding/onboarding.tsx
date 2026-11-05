import { Cloudflare } from "@ridemountainpig/svgl-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import type { Key } from "react-aria-components";
import { cn } from "cn";
import { Skeleton } from "skullet/react";
import { IconRedirectArrow } from "@/components/icons";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronsUpDown,
  IconLogOut,
  IconPlus,
} from "@/components/icons/lucide";
import { IconChevronRight } from "@/components/icons/sidebar";
import { PersonAvatar } from "@/components/settings/account-pages";
import { Button } from "@/components/ui/button";
import { ChoiceBox, ChoiceBoxItem } from "@/components/ui/choice-box";
import { RenewField } from "@/components/ui/copy-field";
import { Label } from "@/components/ui/field";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { DnsRecordsTable } from "@/components/domain/dns-records-table";
import type {
  DnsRecord as TableRecord,
  DomainIssue,
} from "@/components/domain/domain-registry-utils";
import { Text, TextLink } from "@/components/ui/text";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { FieldRevealedError, SlotError } from "@/components/ui/revealed-error";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import {
  useAddDomain,
  useCheckDomain,
  useCreateMailboxes,
  useCreateWorkspace,
  useFinishSetup,
  useOnboarding,
  useOnboardingExit,
  useRotateChallenge,
} from "@/hooks/use-onboarding";
import { useBilling, useStartCheckout, useStartTrial } from "@/hooks/use-billing";
import { useInviteMember } from "@/hooks/use-organization";
import { formatPrice, type Interval } from "@/lib/billing";
import {
  needsSetup,
  ONBOARDING_PAGES,
  pageTitle,
  parseServer as server,
  challengePasses,
  mailRecordsReady,
  ownershipReady,
  pageDone,
  planSet,
  rememberedChallenge,
  resumePage,
  watchDomain,
  type OnboardingPage,
} from "@/lib/onboarding";
import { useRealtimeConnection } from "@/hooks/use-realtime";
import { useSession, useSignOut } from "@/hooks/use-session";
import type { DnsRecord, OnboardingDomain } from "@/lib/types";

// Workspace setup in two long pages of sections, with the steps down a rail on the left (the
// setup's title on top, the signed-in account at the bottom, with the way out). Nothing moves on by
// itself: each page's primary button does, and a step already reached opens again.
//
// Each page calls the API (ADR 0007), which saves how far setup got; an unfinished workspace
// resumes on the first step not done, with what it saved (name, domain, mailbox). The Workspace
// page is the name and domain, then, on the same page once the domain is claimed, its DNS: Omni's
// ownership record (ADR 0010), which locks the domain to the workspace, then the mail records.
// Without Purelymail the domain stays on its mail host: it has no mail records, and the mailbox
// asks for the host's servers and the mailbox's existing password. The Team page is the mailbox,
// the plan where billing is on (ADR 0015), and the invitations.

export function Onboarding() {
  const status = useOnboarding();
  // Decided once, from what the route loaded: finish the active workspace, or start a new one.
  const [resuming, setResuming] = useState(() => needsSetup(status.data?.organization));
  // Only the workspace being set up: a new one has no domain until its first page claims it.
  const domain = resuming ? status.data?.domains[0] : undefined;
  const pages = ONBOARDING_PAGES;
  const done = (p: OnboardingPage) => pageDone(p, status.data, domain);
  const [page, setPage] = useState<OnboardingPage>(() =>
    resuming && status.data ? resumePage(status.data, domain) : "Workspace",
  );
  // A step can be opened once every step before it is done: back to any of them, forward only
  // as far as setup got. Nothing moves on by itself; each page's button does.
  const reachable = (p: OnboardingPage) => pages.slice(0, pages.indexOf(p)).every(done);

  return (
    <OnboardingPage
      pages={pages}
      title={(p) => pageTitle(p, status.data)}
      current={page}
      done={done}
      reachable={reachable}
      onSelect={setPage}
    >
      {page === "Workspace" &&
        (domain ? (
          <DomainForm
            workspace={status.data?.organization?.name ?? ""}
            domain={domain}
            organizationId={status.data?.organization?.id ?? ""}
            onDone={() => setPage("Team")}
          />
        ) : (
          // Claiming the domain keeps this page: its DNS opens under the fields.
          <WorkspaceForm
            existing={resuming ? status.data?.organization?.name : undefined}
            onDone={() => setResuming(true)}
          />
        ))}
      {page === "Team" && domain && (
        <TeamForm
          domain={domain}
          created={status.data?.mailboxes ?? []}
          billing={!!status.data?.billing.enabled}
          planSet={planSet(status.data)}
        />
      )}
    </OnboardingPage>
  );
}

/**
 * The frame every page shares: a rail on the left (above the page on phones) with the setup's
 * title, the steps under it, and the signed-in account at its foot; the page's form beside it.
 */
function OnboardingPage(props: {
  pages: readonly OnboardingPage[];
  title: (p: OnboardingPage) => { title: string; detail: string };
  current: OnboardingPage;
  done: (p: OnboardingPage) => boolean;
  reachable: (p: OnboardingPage) => boolean;
  onSelect: (p: OnboardingPage) => void;
  children: ReactNode;
}) {
  return (
    <main className="min-h-dvh bg-background">
      {/* The rail sits 32px from the screen's top, left and bottom on wide screens; the logo and
          title share one row, the steps hang under it, and the account card stands at the foot. */}
      <aside className="flex flex-col gap-8 px-4 pt-6 md:fixed md:inset-y-8 md:left-8 md:w-60 md:p-0">
        <div className="flex items-center gap-3">
          <IconRedirectArrow />
          <span className="text-sm text-foreground">Set up your workspace</span>
        </div>
        <StepList {...props} />
        {/* At the rail's foot on wide screens; on phones, at the page's foot (below). */}
        <div className="mt-auto hidden md:block">
          <AccountCard />
        </div>
      </aside>
      {/* The page sits right of the screen's centre on wide screens: the rail weighs the left
          side, and true centre reads as pushed left. Narrower, it keeps clear of the rail. */}
      <div className="flex justify-center px-4 py-10 md:pt-23 md:pb-16 md:pr-4 md:pl-72 xl:pl-28">
        {/* One width for every page, so the column doesn't jump between steps. */}
        <div className="flex w-120 max-w-full flex-col">
          {props.children}
          <div className="mt-10 md:hidden">
            <AccountCard />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Setup's steps down the rail: a marker (a green check once done, filled while current, numbered
 * ahead), the step's name and a line on what it holds. A line joins each marker to the next, green
 * once the step above it is done. Every step already reached is a button back to it.
 */
function StepList(props: {
  pages: readonly OnboardingPage[];
  title: (p: OnboardingPage) => { title: string; detail: string };
  current: OnboardingPage;
  done: (p: OnboardingPage) => boolean;
  reachable: (p: OnboardingPage) => boolean;
  onSelect: (p: OnboardingPage) => void;
}) {
  return (
    <nav aria-label="Setup steps">
      <ol className="-ms-0.5 flex flex-col gap-1">
        {props.pages.map((p, i) => {
          const current = p === props.current;
          const done = props.done(p);
          const { title, detail } = props.title(p);
          return (
            <li key={p} className="relative">
              {i < props.pages.length - 1 && (
                // From under this marker to just above the next (button 6px + marker 16px + 4px
                // of air, then 4px of air before the next marker), centred on the markers.
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-6.5 -bottom-2.5 left-[13.5px] w-px",
                    done ? "bg-success" : "bg-border",
                  )}
                />
              )}
              <Button
                intent="plain"
                className="h-auto w-full items-start justify-start gap-2.5 px-1.5 py-1.5 text-start"
                isDisabled={!current && !props.reachable(p)}
                aria-current={current ? "step" : undefined}
                onPress={() => props.onSelect(p)}
              >
                <span
                  aria-hidden
                  className={cn(
                    // `mt-0.5`: the 16px marker centres on the title's 20px line.
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-xs/none tabular-nums",
                    done
                      ? "bg-success text-success-foreground"
                      : // `pt-px`: the figures sit half a pixel high in their line box (ink-measured).
                        current
                        ? "bg-foreground pt-px text-background"
                        : "bg-background pt-px ring-1 ring-border text-muted-foreground",
                  )}
                >
                  {done ? <IconCheck className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "truncate text-sm/5",
                      current ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {title}
                  </span>
                  <span className="truncate text-xs/4 text-subtle-foreground">{detail}</span>
                </span>
                {done && <span className="sr-only">(done)</span>}
              </Button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The signed-in account at the rail's foot: avatar, name and email. Its menu is the way out: back
 * to the inbox or a workspace that's ready (setup stays saved and resumes), and Log out.
 */
function AccountCard() {
  const session = useSession();
  const signOut = useSignOut();
  const { exit, leave } = useOnboardingExit();
  const user = session.data?.user;
  if (!user) return null;
  const name = user.name || user.email;
  return (
    <MenuTrigger>
      <Button
        intent="outline"
        aria-label={`Account, ${name}`}
        className="h-auto w-full justify-start gap-2.5 p-2 text-start"
      >
        <PersonAvatar name={name} image={user.image} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm/4 text-foreground">{name}</span>
          {user.name && (
            <span className="truncate text-xs/4 text-muted-foreground">{user.email}</span>
          )}
        </span>
        <IconChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>
      <Menu placement="top start" popover={{ offset: 8 }}>
        {exit.kind !== "sign-out" && (
          <MenuItem onAction={leave}>
            <IconArrowLeft data-slot="icon" />
            <MenuLabel>
              {exit.kind === "inbox" ? "Back to inbox" : `Back to ${exit.workspace.name}`}
            </MenuLabel>
          </MenuItem>
        )}
        <MenuItem onAction={() => signOut.mutate()}>
          <IconLogOut data-slot="icon" />
          <MenuLabel>Log out</MenuLabel>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

/**
 * Heading, an optional one-line description, the fields, and the submit button. The submit button
 * is the page's one primary action and is never disabled: a page that isn't ready says why when
 * it is pressed.
 */
function PageForm(props: {
  title: string;
  description?: ReactNode;
  submit: string;
  isPending?: boolean;
  /** Why the last submit failed. */
  problem?: string | null;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.isPending) props.onSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Heading>{props.title}</Heading>
        {props.description && <Text>{props.description}</Text>}
      </div>
      <div className="flex flex-col gap-6 pt-8">{props.children}</div>
      {/* The 40px above the button holds the form's error: one line (12 + 16 + 12) appears without
          moving anything, a longer one grows the gap and keeps 12px above the button. */}
      <SlotError className="min-h-10 py-3">{props.problem}</SlotError>
      <Button type="submit" size="lg" className="w-full" isPending={props.isPending}>
        {props.submit}
        <IconChevronRight />
      </Button>
    </form>
  );
}

/**
 * A part of a long page: a short heading, an optional line under it, an optional action that
 * spares the fields (one-click setup), then its fields. Sections are divided by a rule.
 */
function Section(props: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Heading level={2} className="text-sm">
          {props.title}
        </Heading>
        {props.description && <Text>{props.description}</Text>}
        {props.action && <div className="mt-3 flex">{props.action}</div>}
      </div>
      <div className="flex flex-col gap-6">{props.children}</div>
    </section>
  );
}

/** The workspace's name and domain; read-only once the domain is claimed. */
function WorkspaceFields(props: {
  name: string;
  domain: string;
  onName?: (name: string) => void;
  onDomain?: (domain: string) => void;
  nameSaved: boolean;
  domainSaved: boolean;
}) {
  return (
    <>
      <TextField
        value={props.name}
        onChange={props.onName}
        isRequired
        isReadOnly={props.nameSaved}
        autoFocus={!props.nameSaved}
      >
        <Label>Workspace name</Label>
        <Input placeholder="Acme" />
        <FieldRevealedError message="Enter a name for the workspace." />
      </TextField>
      <TextField
        value={props.domain}
        onChange={props.onDomain}
        isRequired
        isReadOnly={props.domainSaved}
        autoFocus={props.nameSaved && !props.domainSaved}
      >
        <Label>Domain</Label>
        <Input placeholder="acme.com" />
        <FieldRevealedError message="Enter your domain, like acme.com." />
      </TextField>
    </>
  );
}

// The page is named for its step, as in the rail; the rail's own title says what the flow is.
const WORKSPACE_TITLE = "Workspace";
const WORKSPACE_DESCRIPTION = "Mail keeps flowing as it does today until DNS changes.";

/**
 * Creates the workspace (unless it exists already), then claims its domain. The page stays: the
 * domain's DNS opens under the fields (`DomainForm`).
 */
function WorkspaceForm(props: { existing?: string; onDone: () => void }) {
  const createWorkspace = useCreateWorkspace();
  const addDomain = useAddDomain();
  const [name, setName] = useState(props.existing ?? "");
  const [domain, setDomain] = useState("");
  // Set once the workspace exists, so a retry after a domain error does not create a second one.
  const [created, setCreated] = useState(props.existing !== undefined);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    setProblem(null);
    try {
      if (!created) {
        await createWorkspace.mutateAsync(name);
        setCreated(true);
      }
      await addDomain.mutateAsync(domain);
      props.onDone();
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  return (
    <PageForm
      title={WORKSPACE_TITLE}
      description={WORKSPACE_DESCRIPTION}
      submit="Continue"
      isPending={createWorkspace.isPending || addDomain.isPending}
      problem={problem}
      onSubmit={() => void submit()}
    >
      <WorkspaceFields
        name={name}
        domain={domain}
        onName={setName}
        onDomain={setDomain}
        nameSaved={created}
        domainSaved={false}
      />
    </PageForm>
  );
}

/** What each check is for. Ownership comes first: the domain is locked to you, and Purelymail adds it, only then. */
const PURPOSES: { check: DnsRecord["check"]; purpose: string }[] = [
  { check: "ownership", purpose: "Prove you own it" },
  { check: "mx", purpose: "Receive mail" },
  { check: "spf", purpose: "Allow sending (SPF)" },
  { check: "dkim", purpose: "Sign outgoing mail (DKIM)" },
  { check: "dmarc", purpose: "Set a policy (DMARC)" },
];

type Diagnostic = NonNullable<DnsRecord["diagnostic"]>;

/** One record as the page shows it. Omni's challenge has no value once its one showing is gone. */
interface ShownRecord {
  check: DnsRecord["check"];
  type: DnsRecord["type"];
  name: string;
  value: string | null;
  priority?: number;
  verified: boolean;
  challenge?: boolean;
  /** What the domain's nameservers held at the last check, and why it is not passing yet. */
  diagnostic: Diagnostic | null;
}

/** Passing: the provider saw it, or the domain's own nameservers already serve it. */
const passes = (r: ShownRecord) => r.verified || r.diagnostic?.status === "ok";

function shownRecords(domain: OnboardingDomain): ShownRecord[] {
  const challenge: ShownRecord[] = domain.challenge
    ? [
        {
          check: "ownership",
          type: domain.challenge.type,
          name: domain.challenge.name,
          value: rememberedChallenge(domain),
          verified: challengePasses(domain),
          challenge: true,
          diagnostic: domain.challenge.diagnostic,
        },
      ]
    : [];
  return [...challenge, ...domain.records];
}

/** The domain's records by purpose, in order, and the first group not passing yet (-1: none). */
function recordGroups(domain: OnboardingDomain) {
  const records = shownRecords(domain);
  const groups = PURPOSES.map((p) => ({
    ...p,
    records: records.filter((r) => r.check === p.check),
  })).filter((g) => g.records.length > 0);
  return { groups, current: groups.findIndex((g) => !g.records.every(passes)) };
}

/** Why a group isn't passing yet: the provider's refusal, then what the nameservers hold. */
function groupProblems(
  domain: OnboardingDomain,
  group: ReturnType<typeof recordGroups>["groups"][number],
) {
  return [
    ...(group.check === "ownership" && domain.addError ? [domain.addError] : []),
    ...group.records
      // "Not found yet" is what the toast's title already says; only other reasons add to it.
      .filter((r) => r.diagnostic && !passes(r) && r.diagnostic.status !== "missing")
      .map((r) => diagnosticText(r.diagnostic!)),
  ];
}

/** Both DNS stages pass: ownership, then the mail records (none on a domain's own host). */
const domainReady = (d: OnboardingDomain) => ownershipReady(d) && mailRecordsReady(d);

/**
 * The domain's DNS, one page in two stages: its ownership records, then the provider's mail
 * records once ownership passes (Purelymail adds the domain only then). Every record of the open
 * stage is listed with its status; Continue checks, opens the next stage when ownership passes,
 * and moves on only when all pass.
 */
function DomainForm(props: {
  workspace: string;
  domain: OnboardingDomain;
  organizationId: string;
  onDone: () => void;
}) {
  const checkDomain = useCheckDomain();
  const rotateChallenge = useRotateChallenge();
  const [problem, setProblem] = useState<string | null>(null);
  const { domain } = props;
  const owned = ownershipReady(domain);
  const { groups } = recordGroups(domain);
  const ownershipRecords = groups.filter((g) => g.check === "ownership").flatMap((g) => g.records);
  const mailRecords = groups.filter((g) => g.check !== "ownership").flatMap((g) => g.records);
  // A domain on its own mail host has no mail records; one moving to Purelymail gets them.
  const mailStage = domain.provider !== "imap" || mailRecords.length > 0;
  // Re-checked on its own while this page is open; results arrive over realtime.
  useRealtimeConnection(props.organizationId);
  useDomainWatch(domain.id, !domainReady(domain));
  // Continue checks first: it moves on once every record passes, else a toast says which isn't
  // passing yet and why. Nothing moves on without it.
  const checkAndContinue = () => {
    setProblem(null);
    // A domain on its own host is checked even when it passes: the check is what moves it to
    // Purelymail once this install has a Purelymail token (then its mail records open here).
    if (domainReady(domain) && domain.provider !== "imap") return props.onDone();
    checkDomain.mutate(domain.id, {
      onSuccess: (fresh) => {
        if (domainReady(fresh)) return props.onDone();
        // Ownership just passed: the mail records stage opens, and says what to add.
        if (!owned && ownershipReady(fresh)) return;
        const group = recordGroups(fresh).groups.find((g) => !g.records.every(passes));
        if (!group) return;
        const type = group.records[0]!.type;
        const why = groupProblems(fresh, group);
        if (why.length > 0)
          appToast.message(`${type} record isn't right yet`, { description: why.join(" ") });
        else
          appToast.message(`${type} record not found yet`, {
            description: "Still checking. DNS can take a few minutes.",
          });
      },
      onError: (error) => setProblem(error.message),
    });
  };
  const rotate = () => {
    setProblem(null);
    rotateChallenge.mutate(domain.id, { onError: (error) => setProblem(error.message) });
  };
  // Domain Connect: the one-click URL carries the challenge value, which exists only while it is
  // fresh; otherwise a new value (and URL) is made first.
  const setUpAutomatically = () => {
    setProblem(null);
    if (domain.domainConnect?.url) return window.location.assign(domain.domainConnect.url);
    rotateChallenge.mutate(domain.id, {
      onSuccess: (fresh) => {
        if (fresh.domainConnect?.url) window.location.assign(fresh.domainConnect.url);
        else
          setProblem(
            "Your DNS host did not offer automatic setup this time. Add the records below.",
          );
      },
      onError: (error) => setProblem(error.message),
    });
  };

  // One stage at a time: ownership, then (once it passes) the mail records it unlocks.
  const mailOpen = owned && mailStage;
  const records = mailOpen ? mailRecords : ownershipRecords;

  return (
    <PageForm
      title={WORKSPACE_TITLE}
      description={WORKSPACE_DESCRIPTION}
      submit="Continue"
      isPending={checkDomain.isPending}
      problem={problem}
      onSubmit={checkAndContinue}
    >
      <WorkspaceFields name={props.workspace} domain={domain.domain} nameSaved domainSaved />
      <Separator />
      <Section
        title={mailOpen ? "Add the mail records" : "Verify you own it"}
        description={
          <>
            Add {records.length === 1 ? "this record" : "each record"} at{" "}
            {domain.dnsHost ? <DnsHostLink host={domain.dnsHost} /> : "the registrar"}.
            {!mailOpen && mailStage && " The mail records come next."}
          </>
        }
        action={
          domain.domainConnect &&
          !domainReady(domain) && (
            <Button
              intent="outline"
              isPending={rotateChallenge.isPending}
              onPress={setUpAutomatically}
            >
              <ProviderLogo name={domain.domainConnect.providerName} />
              Set up automatically with {domain.domainConnect.providerName}
            </Button>
          )
        }
      >
        <DnsRecordsTable
          {...tableData(records)}
          renderValue={(record) => {
            // Omni's ownership value is kept only as a hash: in DNS already, there is nothing to copy
            // or replace; missing or wrong, the field makes a new one.
            const shown = records.find((r) => r.challenge);
            if (!shown || shown.name !== record.name || shown.value !== null) return undefined;
            return passes(shown) ? (
              <span className="text-xs/4 text-muted-foreground">In your DNS</span>
            ) : (
              <RenewField
                placeholder="Hidden"
                tooltip="Make a new value. It replaces the old one."
                isPending={rotateChallenge.isPending}
                onPress={rotate}
              />
            );
          }}
        />
      </Section>
    </PageForm>
  );
}

/** The stage's records and their problems, in the records table's shape (Domain SDK's). */
function tableData(records: ShownRecord[]): { records: TableRecord[]; issues: DomainIssue[] } {
  const rows = records.map((record) => {
    const done = passes(record);
    const wrong = !done && !!record.diagnostic && record.diagnostic.status !== "missing";
    const row: TableRecord = {
      type: record.type,
      name: record.name,
      value:
        record.value === null
          ? ""
          : // A merged SPF record replaces the one already there.
            (record.diagnostic?.suggestion ??
            (record.priority !== undefined ? `${record.priority} ${record.value}` : record.value)),
      purpose: record.check === "ownership" ? "ownership" : "routing",
      required: true,
      status: done ? "valid" : wrong ? "invalid" : "pending",
    };
    const issue: DomainIssue | null = wrong
      ? {
          code: record.diagnostic!.status,
          message:
            record.value === null
              ? `DNS has another value${record.diagnostic!.found.length > 0 ? ` (${record.diagnostic!.found.join(", ")})` : ""}. Make a new value above.`
              : diagnosticText(record.diagnostic!),
          record: row,
          retryable: true,
        }
      : null;
    return { row, issue };
  });
  return {
    records: rows.map((r) => r.row),
    issues: rows.flatMap((r) => (r.issue ? [r.issue] : [])),
  };
}

/**
 * The DNS host's name in the description, linking to its own guide, with where records are added
 * there in a tooltip (hover or focus). It explains the records the user is about to add, so it
 * lives in the sentence that asks for them, not as a paragraph of its own.
 */
function DnsHostLink(props: { host: NonNullable<OnboardingDomain["dnsHost"]> }) {
  return (
    <TooltipTrigger delay={300}>
      <TextLink href={props.host.help} target="_blank" rel="noreferrer">
        {props.host.name}
      </TextLink>
      <Tooltip placement="bottom">{props.host.steps}</Tooltip>
    </TooltipTrigger>
  );
}

/** DNS hosts' logos (svgl) for the one-click button; a host without one shows its name only. */
const PROVIDER_LOGOS: Record<string, typeof Cloudflare> = { Cloudflare };

function ProviderLogo(props: { name: string }) {
  const Logo = PROVIDER_LOGOS[props.name];
  return Logo ? <Logo width={15} height={15} aria-hidden /> : null;
}

/** Why a record is not passing yet, and what the nameservers hold instead. */
function diagnosticText({ message, found }: Diagnostic) {
  return found.length > 0 ? `${message} Found: ${found.join(", ")}` : message;
}

/**
 * Asks the Worker to keep checking the domain while this page is open: once on open, again about
 * every minute (the watch lapses without it), and with a reset when the tab comes back into focus,
 * since that is when someone has just saved a record at their DNS host.
 */
function useDomainWatch(domainId: string, pending: boolean) {
  useEffect(() => {
    if (!pending) return;
    const watch = (reset: boolean) => void watchDomain(domainId, reset).catch(() => {});
    watch(false);
    const renew = setInterval(() => watch(false), 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") watch(true);
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(renew);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [domainId, pending]);
}

type Billing = Extract<NonNullable<ReturnType<typeof useBilling>["data"]>, { enabled: true }>;

/**
 * Monthly and yearly, at Stripe's own prices, so the page shows what will be charged. Without a
 * price (Stripe unreachable just now) the plan is still offered; its amount shows on Stripe.
 */
function planChoices(billing: Billing) {
  const { month, year } = billing.prices;
  const choices: { id: Interval; label: string; description: string }[] = [
    {
      id: "month",
      label: "Monthly",
      description: month ? `${formatPrice(month)} a month` : "Billed every month",
    },
  ];
  if ((billing.intervals as readonly string[]).includes("year")) {
    // Months of the monthly price the yearly one saves, when it saves whole months.
    const free = month && year ? Math.floor((month.amount * 12 - year.amount) / month.amount) : 0;
    choices.push({
      id: "year",
      label: "Yearly",
      description: year
        ? `${formatPrice(year)} a year${free > 0 ? `, ${free} months free` : ""}`
        : "Billed every year",
    });
  }
  return choices;
}

/** Stands in for the plan's prices while they load, so the skeleton has the page's shape. */
const SAMPLE_CHOICES = [
  { id: "month", label: "Monthly", description: "$19 a month" },
  { id: "year", label: "Yearly", description: "$190 a year, 2 months free" },
] as const;

/**
 * The last page, in sections, one button for all of them: the mailbox, the plan (ADR 0015) where
 * billing is on, and the team. Pressed, it makes the mailbox (unless it's saved already: shown as
 * it is and not sent again), then the plan: a new workspace starts the free trial of the plan it
 * picks (no card, no Stripe page; a card is due before the trial ends). Then each address is
 * invited, setup is marked complete, and the inbox opens. A workspace that has had its trial (or a
 * deployment without one) pays on Stripe's page, which returns here with the plan set: the
 * invitations wait for it, so nobody is invited into a workspace without a plan (and nothing typed
 * is lost to the redirect). Every part is saved as it goes, so a retry sends only what's left.
 */
function TeamForm(props: {
  domain: OnboardingDomain;
  /** Mailboxes saved earlier: setup that resumes or comes back here shows the first, fixed. */
  created: { address: string }[];
  billing: boolean;
  planSet: boolean;
}) {
  const navigate = useNavigate();
  const billing = useBilling();
  const createMailboxes = useCreateMailboxes();
  const startTrial = useStartTrial();
  const checkout = useStartCheckout();
  const inviteMember = useInviteMember();
  const finishSetup = useFinishSetup();
  const suffix = `@${props.domain.domain}`;
  // Setup makes one mailbox; more come later, from settings.
  const saved = props.created
    .find((m) => m.address.endsWith(suffix))
    ?.address.slice(0, -suffix.length);
  const [name, setName] = useState(saved ?? "");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState("");
  const [smtp, setSmtp] = useState("");
  const [picked, setPicked] = useState<Interval>("month");
  // Three fields to start: most teams invite a few people at once.
  const [emails, setEmails] = useState(["", "", ""]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The domain stays on its own mail host: the mailbox signs in to its servers, with its password.
  const ask = props.domain.provider === "imap" && saved === undefined;
  const plan = billing.data?.enabled ? billing.data : null;
  const choosing = props.billing && !props.planSet;
  const trial = plan?.trialAvailable ?? true;
  const paying = choosing && !trial;

  async function submit() {
    setProblem(null);
    setSending(true);
    try {
      if (saved === undefined) {
        const servers = ask ? { imap: server(imap, 993), smtp: server(smtp, 465) } : null;
        if (servers && (!servers.imap || !servers.smtp))
          throw new Error("Enter each server as host or host:port.");
        await createMailboxes.mutateAsync({
          domainId: props.domain.id,
          mailboxes: [{ localPart: name.trim(), password }],
          ...(servers?.imap && servers.smtp
            ? { servers: { imap: servers.imap, smtp: servers.smtp } }
            : {}),
        });
      }
      if (paying) {
        await checkout.mutateAsync({ interval: picked, returnPath: "/onboarding" });
        return;
      }
      // Once started, the plan is set (the status refetches), so a retry skips it.
      if (choosing) await startTrial.mutateAsync(picked);
      // Each address leaves the list once invited, so a retry after an error sends only the rest.
      for (const email of emails.map((e) => e.trim()).filter(Boolean)) {
        await inviteMember.mutateAsync({ email });
        setEmails((list) => {
          const rest = list.filter((e) => e.trim() !== email);
          return rest.length > 0 ? rest : [""];
        });
      }
      await finishSetup.mutateAsync();
      await navigate({ to: "/inbox" });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <PageForm
      title="Mailbox and team"
      submit={paying ? "Continue to payment" : choosing ? "Start free trial" : "Finish setup"}
      isPending={sending}
      problem={problem ?? (choosing && billing.error ? billing.error.message : null)}
      onSubmit={() => void submit()}
    >
      <Section
        title="Your mailbox"
        description={
          ask
            ? `${props.domain.domain} stays on its mail host. Omni signs in to it like a mail app.`
            : undefined
        }
      >
        <div className="flex flex-col gap-2">
          <TextField
            value={name}
            onChange={setName}
            isReadOnly={saved !== undefined}
            isRequired
            autoFocus={saved === undefined}
          >
            <Label>Address</Label>
            <InputGroup className="[--input-gutter-end:--spacing(4)]">
              <Input placeholder="name" />
              <span data-slot="text" className="text-sm text-muted-foreground">
                {suffix}
              </span>
            </InputGroup>
            <FieldRevealedError message="Enter the mailbox's name." />
          </TextField>
          {ask && (
            <TextField
              aria-label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              isRequired
            >
              <Input
                placeholder="Password (an app password if your host has them)"
                autoComplete="off"
              />
              <FieldRevealedError
                message={`Enter the password for ${name.trim() || "this mailbox"}${suffix}.`}
              />
            </TextField>
          )}
        </div>
        {ask && (
          <>
            <TextField value={imap} onChange={setImap} isRequired>
              <Label>IMAP server</Label>
              <Input placeholder={`imap.${props.domain.domain}:993`} />
              <FieldRevealedError message="Enter the IMAP server." />
            </TextField>
            <TextField value={smtp} onChange={setSmtp} isRequired>
              <Label>SMTP server</Label>
              <Input placeholder={`smtp.${props.domain.domain}:465`} />
              <FieldRevealedError message="Enter the SMTP server." />
            </TextField>
          </>
        )}
      </Section>
      {props.billing && (
        <>
          <Separator />
          <Section
            title={
              !choosing ? "Your plan is set" : trial ? "Start your free trial" : "Choose your plan"
            }
            description={
              !choosing
                ? "Change it any time in Settings, Billing."
                : trial
                  ? `Free for ${plan?.trialDays ?? 14} days. Add a card before it ends to keep going.`
                  : "One price for everyone, every inbox and every domain. Invite your team after."
            }
          >
            {choosing && (
              <Skeleton
                data={plan ? planChoices(plan) : null}
                sample={[...SAMPLE_CHOICES]}
                label="Loading plans"
              >
                {(choices) => (
                  <ChoiceBox
                    aria-label="Plan"
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={[picked]}
                    onSelectionChange={(keys) => {
                      const [key] = [...(keys as Set<Key>)];
                      if (key === "month" || key === "year") setPicked(key);
                    }}
                    items={choices}
                  >
                    {(item) => (
                      <ChoiceBoxItem
                        id={item.id}
                        label={item.label}
                        description={item.description}
                      />
                    )}
                  </ChoiceBox>
                )}
              </Skeleton>
            )}
          </Section>
        </>
      )}
      {!paying && (
        <>
          <Separator />
          <Section title="Invite your team">
            <InputList
              label="Emails"
              optional
              values={emails}
              onChange={setEmails}
              addLabel="Add another"
              render={(value, set, i) => (
                <TextField
                  aria-label={`Email ${i + 1}`}
                  type="email"
                  value={value}
                  onChange={set}
                  // A field just added takes focus; the page's first field is the mailbox.
                  autoFocus={emails.length > 3 && i === emails.length - 1}
                >
                  <Input placeholder={`teammate@${props.domain.domain}`} />
                  <FieldRevealedError message="Enter a valid email address." />
                </TextField>
              )}
            />
          </Section>
        </>
      )}
    </PageForm>
  );
}

/** A labeled list of inputs that grows with "Add …". */
function InputList(props: {
  label: string;
  optional?: boolean;
  values: string[];
  onChange: (values: string[]) => void;
  addLabel: string;
  render: (value: string, set: (value: string) => void, index: number) => ReactNode;
}) {
  const { values, onChange } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">
        {props.label}
        {props.optional && <span className="ms-1 text-subtle-foreground">(Optional)</span>}
      </span>
      <div className="flex flex-col gap-2">
        {values.map((value, i) => (
          <div key={i}>
            {props.render(value, (v) => onChange(values.map((old, j) => (j === i ? v : old))), i)}
          </div>
        ))}
      </div>
      <Button
        intent="outline"
        className="mt-1 self-start"
        onPress={() => onChange([...values, ""])}
      >
        <IconPlus />
        {props.addLabel}
      </Button>
    </div>
  );
}
