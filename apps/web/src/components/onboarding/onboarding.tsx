import { Cloudflare } from "@ridemountainpig/svgl-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import type { Key } from "react-aria-components";
import { Skeleton } from "skullet/react";
import { IconRedirectArrow } from "@/components/icons";
import { IconChevronLeft, IconChevronRight } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { ChoiceBox, ChoiceBoxItem } from "@/components/ui/choice-box";
import { CopyField, RenewField } from "@/components/ui/copy-field";
import { Label } from "@/components/ui/field";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { Step, Steps, type StepState } from "@/components/ui/steps";
import { Text, TextLink } from "@/components/ui/text";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
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
  onboardingPages,
  parseServer as server,
  rememberedChallenge,
  resumePage,
  watchDomain,
  type OnboardingPage,
} from "@/lib/onboarding";
import { useRealtimeConnection } from "@/hooks/use-realtime";
import type { DnsRecord, OnboardingDomain } from "@/lib/types";

// Workspace setup, one short form per page (layout from the Figma references 16:1400 and
// 25:1509, on our tokens). Only DNS uses steps: each record is checked before the next.
//
// Each page calls the API (ADR 0007), which saves how far setup got; an unfinished workspace
// resumes on that step's page with what it saved (name, domain, mailboxes). The DNS page starts
// with Omni's ownership record (ADR 0010), which locks the domain to the workspace. Without
// Purelymail that is the only record: the domain stays on its mail host, the same page then asks
// for that host's servers, and each mailbox is added with its existing password. Where billing
// is on (ADR 0015), a plan page follows mailboxes: the free trial or a paid plan, through Stripe.

/** `host` or `host:port`; the port defaults to the implicit-TLS one. */
type Servers = { imap: { host: string; port: number }; smtp: { host: string; port: number } };

export function Onboarding() {
  const status = useOnboarding();
  // Decided once, from what the route loaded: finish the active workspace, or start a new one.
  const [resuming, setResuming] = useState(() => needsSetup(status.data?.organization));
  const pages = onboardingPages(status.data);
  const [page, setPage] = useState<OnboardingPage>(() =>
    resuming && status.data ? resumePage(status.data) : "Workspace",
  );
  const index = pages.indexOf(page);
  const [servers, setServers] = useState<Servers | null>(null);
  // Only the workspace being set up: a new one has no domain until page 0 adds it.
  const domain = resuming ? status.data?.domains[0] : undefined;
  const ownHost = domain?.provider === "imap";
  // On its own host the domain proves ownership on the DNS page like any other; the Mailboxes page
  // then asks for the servers first (they live only in memory), so no path reaches the mailbox
  // form without them and Back never lands on a step that was skipped.
  const askServers = page === "Mailboxes" && ownHost && !servers;
  // A workspace with a plan has nothing to do on the plan page: it is passed over both ways.
  const passed = (p: OnboardingPage) => p === "Plan" && !status.data?.organization?.needsPlan;
  const next = () => {
    const after = pages.slice(index + 1).find((p) => !passed(p));
    setPage(after ?? pages[pages.length - 1]!);
  };
  // Never back onto the first page: the workspace and domain it saved stay saved. From the
  // mailbox form on its own host, Back returns to the servers it was given.
  const previous = pages
    .slice(1, Math.max(index, 1))
    .toReversed()
    .find((p) => !passed(p));
  const back =
    page === "Mailboxes" && ownHost && servers
      ? () => setServers(null)
      : previous
        ? () => setPage(previous)
        : undefined;

  return (
    <OnboardingPage page={index} names={pages} onBack={back}>
      {page === "Workspace" && (
        <WorkspaceForm
          existing={resuming ? status.data?.organization?.name : undefined}
          onDone={() => {
            setResuming(true);
            next();
          }}
        />
      )}
      {page === "DNS" && domain && (
        <DnsForm
          domain={domain}
          organizationId={status.data?.organization?.id ?? ""}
          onDone={next}
        />
      )}
      {askServers && domain && <ServerForm domain={domain.domain} onDone={setServers} />}
      {page === "Mailboxes" && domain && !askServers && (
        <MailboxesForm
          domain={domain}
          servers={ownHost ? servers : null}
          created={status.data?.mailboxes ?? []}
          onDone={next}
        />
      )}
      {page === "Plan" && <PlanForm onDone={next} />}
      {page === "Invite" && <InviteForm domain={domain?.domain} />}
    </OnboardingPage>
  );
}

/**
 * The frame every page shares: logo, step progress, the page's form, and one quiet action under
 * it. That action goes back a page; on the first page, for someone with nowhere else to go, it
 * signs out. Leaving setup for a workspace that is ready is a separate way out, top left.
 */
function OnboardingPage(props: {
  page: number;
  names: readonly string[];
  onBack?: () => void;
  children: ReactNode;
}) {
  const { exit, leave, isPending } = useOnboardingExit();
  const below = props.onBack
    ? { label: "Back", onPress: props.onBack, isPending: false }
    : props.page === 0 && exit.kind === "sign-out"
      ? { label: "Sign out", onPress: leave, isPending }
      : null;
  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-16">
      {exit.kind !== "sign-out" && (
        // Setup stays saved and resumes on return. Optical: `top-3.75` puts the label's ink as far
        // from the window's top (23.5px) as the chevron's is from its left.
        <Button
          intent="plain"
          size="xs"
          className="fixed top-3.75 left-3 text-muted-foreground"
          isPending={isPending}
          onPress={leave}
        >
          <IconChevronLeft />
          {exit.kind === "inbox" ? "Back to inbox" : `Back to ${exit.workspace.name}`}
        </Button>
      )}
      <div className="flex w-100 max-w-full flex-col">
        <div className="flex justify-center">
          <IconRedirectArrow />
        </div>
        <StepProgress current={props.page} names={props.names} />
        {props.children}
        {below && (
          <Button
            intent="plain"
            className="mt-3 self-center text-muted-foreground"
            isPending={below.isPending}
            onPress={below.onPress}
          >
            {below.label}
          </Button>
        )}
      </div>
    </main>
  );
}

/**
 * One bar per step, filled through the current one. No visible "Step 2 of 4" over it: the heading
 * below names the step, and the bar's own label says where you are to assistive tech.
 *
 * Room, in ink: 51.5px from the logo to the bar (the logo box's 3.5px of air plus `pt-12`), then
 * 35px from the bar to the heading (PageForm's `pt-8` plus the heading's line slack). The bar
 * sits nearer the heading it leads into than the logo above, so it reads as the page's top.
 */
function StepProgress(props: { current: number; names: readonly string[] }) {
  const { current, names } = props;
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={1}
      aria-valuemax={names.length}
      aria-valuenow={current + 1}
      aria-valuetext={`Step ${current + 1} of ${names.length}: ${names[current]}`}
      className="flex gap-1 pt-12"
    >
      {names.map((name, i) => (
        <span
          key={name}
          className={`h-1 flex-1 rounded-full ${i <= current ? "bg-foreground" : "bg-border"}`}
        />
      ))}
    </div>
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
  /**
   * An action that spares the fields (one-click setup). It belongs to the sentence above it: 24px
   * of ink under the description, 32px over the fields.
   */
  shortcut?: ReactNode;
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
      <div className="flex flex-col gap-1.5 pt-8">
        <Heading>{props.title}</Heading>
        {props.description && <Text>{props.description}</Text>}
        {props.shortcut && <div className="mt-4.5 flex">{props.shortcut}</div>}
      </div>
      <div className="flex flex-col gap-6 pt-8">{props.children}</div>
      {props.problem && (
        // Said like a field's own error, under the fields it is about: no banner.
        <p role="alert" className="mt-4 text-sm/6 text-danger-subtle-foreground">
          {props.problem}
        </p>
      )}
      <Button type="submit" size="lg" className="mt-10 w-full" isPending={props.isPending}>
        {props.submit}
        <IconChevronRight />
      </Button>
    </form>
  );
}

/** Creates the workspace (unless it exists already), then claims its domain. */
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
      title="Set up your workspace"
      description="Mail keeps flowing as it does today until DNS changes."
      submit="Continue"
      isPending={createWorkspace.isPending || addDomain.isPending}
      problem={problem}
      onSubmit={() => void submit()}
    >
      <TextField
        value={name}
        onChange={setName}
        isRequired
        isReadOnly={created}
        autoFocus={!created}
      >
        <Label>Workspace name</Label>
        <Input placeholder="Acme" />
      </TextField>
      <TextField value={domain} onChange={setDomain} isRequired autoFocus={created}>
        <Label>Domain</Label>
        <Input placeholder="acme.com" />
      </TextField>
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
          verified: domain.challenge.verified,
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

function DnsForm(props: { domain: OnboardingDomain; organizationId: string; onDone: () => void }) {
  const checkDomain = useCheckDomain();
  const rotateChallenge = useRotateChallenge();
  const [problem, setProblem] = useState<string | null>(null);
  const { domain } = props;
  const { groups, current } = recordGroups(domain);
  // Re-checked on its own while this page is open; results arrive over realtime.
  useRealtimeConnection(props.organizationId);
  useDomainWatch(domain.id, current !== -1);
  const state = (i: number): StepState =>
    current === -1 || i < current ? "complete" : i === current ? "current" : "upcoming";
  // Continue checks first: it moves on once every record passes, else a toast says which record
  // isn't passing yet and why. No disabled button, no per-step check buttons, no status lines.
  const checkAndContinue = () => {
    setProblem(null);
    // A domain on its own host is checked again even when it passes: the check is what moves it
    // to Purelymail once this install has a Purelymail token (it then shows Purelymail's records).
    if (current === -1 && domain.provider !== "imap") return props.onDone();
    checkDomain.mutate(domain.id, {
      onSuccess: (fresh) => {
        const after = recordGroups(fresh);
        if (after.current === -1) return props.onDone();
        const group = after.groups[after.current]!;
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

  return (
    <PageForm
      title="Connect your domain"
      description={
        <>
          Add each record at{" "}
          {domain.dnsHost ? <DnsHostLink host={domain.dnsHost} /> : "the registrar"} for{" "}
          {domain.domain}.
        </>
      }
      shortcut={
        domain.domainConnect &&
        current !== -1 && (
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
      submit="Continue"
      isPending={checkDomain.isPending}
      problem={problem}
      onSubmit={checkAndContinue}
    >
      <Steps>
        {groups.map((group, i) => (
          <Step
            key={group.check}
            state={state(i)}
            label={group.records[0]!.type}
            title={group.purpose}
          >
            <div className="flex flex-col gap-2 [--copy-label-width:--spacing(13)]">
              {group.records.map((record) => (
                <div key={record.name} className="flex flex-col gap-2">
                  <CopyField label="Host" value={record.name} />
                  {record.value !== null ? (
                    <CopyField
                      label="Value"
                      value={
                        // A merged SPF record replaces the one already there.
                        record.diagnostic?.suggestion ??
                        (record.priority !== undefined
                          ? `${record.priority} ${record.value}`
                          : record.value)
                      }
                    />
                  ) : (
                    // Only its hash is stored, so a value shown before (another browser, cleared
                    // storage) cannot be shown again: the field makes a new one when pressed. Not
                    // made on its own: it would replace a record the user may have just added.
                    <RenewField
                      label="Value"
                      placeholder="Hidden"
                      tooltip="Show a new value. It replaces the old one."
                      isPending={rotateChallenge.isPending}
                      onPress={rotate}
                    />
                  )}
                </div>
              ))}
            </div>
          </Step>
        ))}
      </Steps>
    </PageForm>
  );
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

/** Without Purelymail: the existing mail host's servers, which every mailbox signs in to. */
function ServerForm(props: { domain: string; onDone: (servers: Servers) => void }) {
  const [imap, setImap] = useState("");
  const [smtp, setSmtp] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <PageForm
      title="Connect your mail server"
      description={`${props.domain} stays on its mail host. Omni signs in to it like a mail app.`}
      submit="Continue"
      problem={problem}
      onSubmit={() => {
        const servers = { imap: server(imap, 993), smtp: server(smtp, 465) };
        if (!servers.imap || !servers.smtp) setProblem("Enter each server as host or host:port.");
        else props.onDone({ imap: servers.imap, smtp: servers.smtp });
      }}
    >
      <TextField value={imap} onChange={setImap} isRequired autoFocus>
        <Label>IMAP server</Label>
        <Input placeholder={`imap.${props.domain}:993`} />
      </TextField>
      <TextField value={smtp} onChange={setSmtp} isRequired>
        <Label>SMTP server</Label>
        <Input placeholder={`smtp.${props.domain}:465`} />
      </TextField>
    </PageForm>
  );
}

function MailboxesForm(props: {
  domain: OnboardingDomain;
  /** Set on the bring-your-own-host path: the mailbox then needs its password. */
  servers: Servers | null;
  /** Mailboxes saved earlier: setup that resumes or comes back here shows the first, fixed. */
  created: { address: string }[];
  onDone: () => void;
}) {
  const createMailboxes = useCreateMailboxes();
  const suffix = `@${props.domain.domain}`;
  // Setup makes one mailbox; more come later, from settings. One made already is shown as it is
  // and not sent again.
  const [saved] = useState(() =>
    props.created.find((m) => m.address.endsWith(suffix))?.address.slice(0, -suffix.length),
  );
  const [name, setName] = useState(saved ?? "");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const { servers } = props;

  return (
    <PageForm
      title="Create your mailbox"
      description={
        servers && !saved ? "With its password (an app password if your host has them)." : undefined
      }
      submit="Continue"
      isPending={createMailboxes.isPending}
      problem={problem}
      onSubmit={() => {
        setProblem(null);
        if (saved) return props.onDone();
        createMailboxes.mutate(
          {
            domainId: props.domain.id,
            mailboxes: [{ localPart: name.trim(), password }],
            ...(servers ? { servers } : {}),
          },
          { onSuccess: props.onDone, onError: (error) => setProblem(error.message) },
        );
      }}
    >
      <div className="flex flex-col gap-2">
        <TextField value={name} onChange={setName} isReadOnly={!!saved} isRequired autoFocus>
          <Label>Address</Label>
          <InputGroup className="[--input-gutter-end:--spacing(4)]">
            <Input placeholder="name" />
            <span data-slot="text" className="text-sm text-muted-foreground">
              {suffix}
            </span>
          </InputGroup>
        </TextField>
        {servers && !saved && (
          <TextField
            aria-label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            isRequired
          >
            <Input placeholder="Password" autoComplete="off" />
          </TextField>
        )}
      </div>
    </PageForm>
  );
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
 * The plan (ADR 0015). Every new workspace starts on the free trial of the plan it picks: no card,
 * no Stripe page, setup just moves on, and a card is due before the trial ends. A workspace that
 * has had its trial (or a deployment without one) pays on Stripe's page, which returns here.
 * Shown only while the workspace has no plan; the page is passed over otherwise.
 */
function PlanForm(props: { onDone: () => void }) {
  const billing = useBilling();
  const startTrial = useStartTrial();
  const checkout = useStartCheckout();
  const [picked, setPicked] = useState<Interval>("month");
  const [problem, setProblem] = useState<string | null>(null);
  const plan = billing.data?.enabled ? billing.data : null;
  const trial = plan?.trialAvailable ?? true;
  const fail = (error: Error) => setProblem(error.message);

  return (
    <PageForm
      title={trial ? "Start your free trial" : "Choose your plan"}
      description={
        trial
          ? `Free for ${plan?.trialDays ?? 14} days. Add a card before it ends to keep going.`
          : "One price for everyone, every inbox and every domain."
      }
      submit={trial ? "Start free trial" : "Continue to payment"}
      isPending={startTrial.isPending || checkout.isPending}
      problem={problem ?? (billing.error ? billing.error.message : null)}
      onSubmit={() => {
        setProblem(null);
        if (trial) startTrial.mutate(picked, { onSuccess: props.onDone, onError: fail });
        else checkout.mutate({ interval: picked, returnPath: "/onboarding" }, { onError: fail });
      }}
    >
      <Skeleton
        data={plan ? planChoices(plan) : null}
        sample={[...SAMPLE_CHOICES]}
        label="Loading plans"
      >
        {(choices) => (
          <ChoiceBox
            // Optical: other pages' first field starts with a label's text (and its line slack);
            // this one starts with a border. 4px more puts 35px of ink under the description, as
            // there.
            className="mt-1"
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
              <ChoiceBoxItem id={item.id} label={item.label} description={item.description} />
            )}
          </ChoiceBox>
        )}
      </Skeleton>
    </PageForm>
  );
}

/**
 * Invites each address into the new workspace (the existing invitation flow), marks setup
 * complete, then opens the inbox.
 */
function InviteForm(props: { domain?: string }) {
  const navigate = useNavigate();
  const inviteMember = useInviteMember();
  const finishSetup = useFinishSetup();
  const [emails, setEmails] = useState([""]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    setProblem(null);
    setSending(true);
    try {
      for (const email of emails.map((e) => e.trim()).filter(Boolean)) {
        await inviteMember.mutateAsync({ email });
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
      title="Invite your team"
      submit="Finish setup"
      isPending={sending}
      problem={problem}
      onSubmit={() => void submit()}
    >
      <InputList
        label="Emails"
        optional
        values={emails}
        onChange={setEmails}
        addLabel="Add person"
        render={(value, set, i) => (
          <TextField
            aria-label={`Email ${i + 1}`}
            type="email"
            value={value}
            onChange={set}
            autoFocus={i === emails.length - 1}
          >
            <Input placeholder={`teammate@${props.domain ?? "acme.com"}`} />
          </TextField>
        )}
      />
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
        intent="plain"
        size="xs"
        className="self-start px-0 text-muted-foreground"
        onPress={() => onChange([...values, ""])}
      >
        {props.addLabel}
      </Button>
    </div>
  );
}
