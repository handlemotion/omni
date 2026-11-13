import { Cloudflare, Google } from "@ridemountainpig/svgl-react";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Key } from "react-aria-components";
import { cn } from "cn";
import { Skeleton } from "skullet/react";
import {
  IconArrowLeft,
  IconArrowRotateClockwise,
  IconCheck,
  IconChevronsUpDown,
  IconLogOut,
  IconMail,
  IconPlus,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChoiceBox, ChoiceBoxItem } from "@/components/ui/choice-box";
import { Label } from "@/components/ui/field";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { DnsRecordsTable } from "@/components/domain/dns-records-table";
import type {
  DnsRecord as TableRecord,
  DomainIssue,
} from "@/components/domain/domain-registry-utils";
import { Text, TextLink } from "@/components/ui/text";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { TextField } from "@/components/ui/text-field";
import { setupToast } from "@/components/ui/toast";
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
import {
  useConnectGoogle,
  useGoogleAccounts,
  useGoogleReturn,
} from "@/hooks/use-google-connection";
import { useInviteMember } from "@/hooks/use-organization";
import { formatPrice, type Interval } from "@/lib/billing";
import { googleErrorText, type GoogleOutcome } from "@/lib/google-connection";
import {
  needsSetup,
  onboardingPages,
  PAGE_TITLES,
  parseServer as server,
  challengePasses,
  mailRecordsReady,
  ownershipReady,
  pageDone,
  rememberedChallenge,
  resumePage,
  watchDomain,
  type OnboardingPage,
} from "@/lib/onboarding";
import { useRealtimeConnection } from "@/hooks/use-realtime";
import { useSession, useSignOut } from "@/hooks/use-session";
import type { DnsRecord, Onboarding as OnboardingStatus, OnboardingDomain } from "@/lib/types";

// Workspace setup in four short steps, one column each, the progress dots at the bottom:
//
// 1. Welcome: the workspace's name, the only field.
// 2. Connect your inbox: one "Connect Google" button, which leaves for Google's consent screen and
//    comes back here connected. A quiet "Use your own domain instead" opens the domain path: the
//    domain, its DNS (Omni's ownership record, ADR 0010, then the mail records), then a mailbox.
//    A domain that stays on its own mail host has no mail records, and its mailbox asks for the
//    host's servers and the mailbox's password.
// 3. Invite your team: emails, or skip.
// 4. Plan, only where billing is on (ADR 0015): start the trial, then the inbox opens.
//
// Each step calls the API (ADR 0007), which saves how far setup got; an unfinished workspace
// resumes on the first step not done.

export function Onboarding() {
  const status = useOnboarding();
  // Google's way back to the inbox step, read once on this load.
  const googleReturn = useGoogleReturn();
  // Decided once, from what the route loaded: finish the active workspace, or start a new one.
  const [resuming, setResuming] = useState(() => needsSetup(status.data?.organization));
  // Only the workspace being set up: a new one has nothing saved until its first step.
  const data = resuming ? status.data : undefined;
  const pages = onboardingPages(status.data);
  const [page, setPage] = useState<OnboardingPage>(() => {
    if (!resuming || !status.data) return "Workspace";
    return googleReturn ? "Inbox" : resumePage(status.data);
  });
  const index = pages.indexOf(page);
  const finish = useFinish();
  const next = (from: OnboardingPage) => {
    const after = pages[pages.indexOf(from) + 1];
    if (after) setPage(after);
    else finish.run();
  };
  // Back steps to the page before; the dots only show where setup is (dorks' onboarding).
  const previous = pages[index - 1];
  const back = previous ? () => setPage(previous) : undefined;

  return (
    <OnboardingPage pages={pages} current={page} onBack={back}>
      {page === "Workspace" && (
        <WorkspaceForm
          existing={resuming ? status.data?.organization?.name : undefined}
          onDone={() => {
            setResuming(true);
            next("Workspace");
          }}
        />
      )}
      {page === "Inbox" && (
        <InboxStep data={data} googleReturn={googleReturn} onDone={() => next("Inbox")} />
      )}
      {page === "Team" && (
        <InviteForm
          finishing={finish.isPending}
          finishProblem={finish.problem}
          onDone={() => next("Team")}
        />
      )}
      {page === "Plan" &&
        (pageDone("Plan", data) ? (
          <PageForm
            title="Your plan is set"
            description="Change it any time in Settings, Billing."
            submit="Finish setup"
            isPending={finish.isPending}
            problem={finish.problem}
            onSubmit={finish.run}
          >
            {null}
          </PageForm>
        ) : (
          <PlanForm
            finishing={finish.isPending}
            finishProblem={finish.problem}
            onDone={finish.run}
          />
        ))}
    </OnboardingPage>
  );
}

/** Marks setup complete and opens the inbox: the last step's button. */
function useFinish() {
  const navigate = useNavigate();
  const finishSetup = useFinishSetup();
  return {
    run: () => finishSetup.mutate(undefined, { onSuccess: () => void navigate({ to: "/inbox" }) }),
    isPending: finishSetup.isPending || finishSetup.isSuccess,
    problem: finishSetup.error?.message ?? null,
  };
}

const BackContext = createContext<(() => void) | undefined>(undefined);

/**
 * Validation and failures go to a toast (top centre during setup), never under a field, so
 * nothing on the page shifts (dorks' onboarding). The buttons stay enabled: pressing one with
 * something missing says what. The same message twice replaces itself instead of stacking.
 */
const notify = (message: string) => setupToast(message);

/** Points Back somewhere else inside a step (the inbox step's own views), or hides it. */
function WithBack(props: { onBack: (() => void) | undefined; children: ReactNode }) {
  return <BackContext.Provider value={props.onBack}>{props.children}</BackContext.Provider>;
}

/**
 * The frame every page shares, after dorks' onboarding: no rail or app chrome, one column in the
 * middle, the progress dots at the bottom, and the account in the top corner as the way out. The
 * dots and the column read the same `current`, so they cannot disagree.
 */
function OnboardingPage(props: {
  pages: readonly OnboardingPage[];
  current: OnboardingPage;
  onBack?: () => void;
  children: ReactNode;
}) {
  const index = props.pages.indexOf(props.current);
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-clip bg-background">
      <div className="absolute top-4 left-4 md:top-6 md:left-6">
        <AccountSwitcher />
      </div>
      <BackContext.Provider value={props.onBack}>
        {/* Keyed by page so each page enters on its own instead of morphing out of the last.
            450px of content, as in dorks. */}
        <main
          key={props.current}
          className="mx-auto flex w-full max-w-136.5 flex-1 flex-col justify-center px-4 pt-20 pb-24 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 md:px-12"
        >
          {props.children}
        </main>
      </BackContext.Provider>
      <ol
        aria-label={`Step ${index + 1} of ${props.pages.length}, ${PAGE_TITLES[props.current]}`}
        className="absolute inset-x-0 bottom-12 flex justify-center gap-3"
      >
        {props.pages.map((p, i) => (
          <li
            key={p}
            aria-current={i === index ? "step" : undefined}
            className={cn(
              "size-2 rounded-full transition-colors duration-300",
              i === index ? "bg-primary" : "bg-foreground/15",
            )}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * The signed-in account in the top corner, as the app sidebar's switcher: a plain trigger (avatar,
 * name, chevron) whose menu is the way out: back to the inbox or a workspace that's ready (setup
 * stays saved and resumes), and Log out.
 */
function AccountSwitcher() {
  const session = useSession();
  const signOut = useSignOut();
  const { exit, leave } = useOnboardingExit();
  const user = session.data?.user;
  if (!user) return null;
  const name = user.name || user.email;
  return (
    <MenuTrigger>
      <Button
        intent="plain"
        aria-label={`Account, ${name}`}
        // The sidebar switcher's trigger: hover, pressed and open share the accent fill.
        className="h-7 max-w-60 min-w-0 justify-start gap-2.5 rounded-sm px-1.5 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
        {/* 16px: at that size an initial is a speck, so a person without a picture gets a plain
            disc. */}
        <Avatar
          src={user.image ?? null}
          className="bg-accent outline-0 [--avatar-size:--spacing(4)]"
        />
        <span className="min-w-0 truncate">{name}</span>
        <IconChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>
      <Menu placement="bottom start" popover={{ offset: 8 }}>
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
 * Heading, an optional line or two under it, the fields, then the step's buttons: Back (when there
 * is a page behind) and the primary one, both Omni's 32px buttons, centred (dorks' onboarding layout). The primary button is
 * never disabled: a page that isn't ready says why when it is pressed.
 */
function PageForm(props: {
  title: string;
  description?: ReactNode;
  submit: string;
  /** A second action, an outline button beside the primary one. Back then moves under them. */
  secondary?: ReactNode;
  isPending?: boolean;
  /** Why the last submit failed. */
  problem?: string | null;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const onBack = useContext(BackContext);
  useEffect(() => {
    if (props.problem) notify(props.problem);
  }, [props.problem]);
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.isPending) props.onSubmit();
      }}
    >
      <div className="flex flex-col gap-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <Heading>{props.title}</Heading>
          {props.description && <Text className="max-w-100 text-balance">{props.description}</Text>}
        </header>
        {props.children}
      </div>
      {/* 40px over the buttons. Errors are toasts (`notify`), so nothing here moves. */}
      <div className="h-10" />
      <div className="flex items-center justify-center gap-2">
        {onBack && !props.secondary && (
          <Button intent="ghost" className="text-muted-foreground" onPress={onBack}>
            Back
          </Button>
        )}
        {props.secondary}
        <Button type="submit" isPending={props.isPending}>
          {props.submit}
        </Button>
      </div>
      {onBack && props.secondary && (
        <div className="mt-4 flex justify-center">
          <Button intent="ghost" className="text-muted-foreground" onPress={onBack}>
            Back
          </Button>
        </div>
      )}
    </form>
  );
}

/** The workspace's name: the welcome page's only field. Read-only once the workspace exists. */
function WorkspaceForm(props: { existing?: string; onDone: () => void }) {
  const createWorkspace = useCreateWorkspace();
  const [name, setName] = useState(props.existing ?? "");
  const exists = props.existing !== undefined;
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <PageForm
      title="Welcome to Omni"
      description="Create your workspace by giving it a name."
      submit="Continue"
      isPending={createWorkspace.isPending}
      problem={problem}
      onSubmit={() => {
        setProblem(null);
        if (exists) return props.onDone();
        if (!name.trim()) return notify("Enter a name for the workspace.");
        createWorkspace.mutate(name, {
          onSuccess: props.onDone,
          onError: (error) => setProblem(error.message),
        });
      }}
    >
      <TextField value={name} onChange={setName} isReadOnly={exists} autoFocus>
        <Label>Workspace name</Label>
        <Input placeholder="Acme" />
      </TextField>
    </PageForm>
  );
}

/** Where the inbox step is: Google, or one of the own-domain path's three views. */
type InboxView = "connect" | "domain" | "dns" | "mailbox";

/**
 * The inbox step. Connecting Google is the way through; "Use your own domain instead" opens the
 * domain, its DNS and a mailbox, each a view of this one step, with Back walking them in reverse.
 * Without a Google client on this install, the domain path is the step.
 */
function InboxStep(props: {
  data: OnboardingStatus | undefined;
  googleReturn: GoogleOutcome | null;
  onDone: () => void;
}) {
  const google = useGoogleAccounts();
  const stepBack = useContext(BackContext);
  const domain = props.data?.domains[0];
  const mailboxes = props.data?.mailboxes ?? [];
  const [view, setView] = useState<InboxView>(() => {
    if (mailboxes.length > 0 || props.googleReturn || !domain) return "connect";
    return domainReady(domain) && domain.provider !== "imap" ? "mailbox" : "dns";
  });
  // No Google here: the domain path is all there is, and its first view goes back a step.
  const googleOff = google.data?.available === false && mailboxes.length === 0;
  const shown = view === "connect" && googleOff ? (domain ? "dns" : "domain") : view;
  const toConnect = googleOff ? stepBack : () => setView("connect");

  if (shown === "connect") {
    return (
      <ConnectInboxForm
        mailboxes={mailboxes}
        problem={
          props.googleReturn?.kind === "error" ? googleErrorText(props.googleReturn.reason) : null
        }
        onOwnDomain={() => setView(domain ? "dns" : "domain")}
        onDone={props.onDone}
      />
    );
  }
  if (shown === "domain" || !domain) {
    return (
      <WithBack onBack={toConnect}>
        <DomainEntryForm onDone={() => setView("dns")} />
      </WithBack>
    );
  }
  if (shown === "dns") {
    return (
      <WithBack onBack={toConnect}>
        <DomainForm
          domain={domain}
          organizationId={props.data?.organization?.id ?? ""}
          onDone={() => setView("mailbox")}
        />
      </WithBack>
    );
  }
  return (
    <WithBack onBack={() => setView("dns")}>
      <MailboxesForm
        domain={domain}
        ownHost={domain.provider === "imap"}
        created={mailboxes}
        onDone={props.onDone}
      />
    </WithBack>
  );
}

/**
 * One "Connect Google" button, which leaves for Google and comes back here connected. Once an
 * inbox exists, it is listed and Continue moves on. Personal Gmail only (ADR 0023): a shared
 * support@ address goes through your own domain, so the copy doesn't promise one.
 */
function ConnectInboxForm(props: {
  mailboxes: OnboardingStatus["mailboxes"];
  problem: string | null;
  onOwnDomain: () => void;
  onDone: () => void;
}) {
  const connect = useConnectGoogle("onboarding");
  // An island of rows (dorks' connect step): each inbox connected, then rows to add one, at least
  // three rows in all and always one to add, so the card never changes shape as it fills.
  const open = Math.max(1, 3 - props.mailboxes.length);
  return (
    <PageForm
      title="Connect your inbox"
      description="Sign in with Google and your Gmail opens in Omni, ready to read and answer."
      submit="Continue"
      problem={props.problem}
      onSubmit={() =>
        props.mailboxes.length > 0 ? props.onDone() : notify("Connect an inbox first.")
      }
      secondary={
        <Button intent="outline" onPress={props.onOwnDomain}>
          Use Omni instead
        </Button>
      }
    >
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
        {props.mailboxes.map((m) => (
          <li key={m.id} className="flex h-12 items-center gap-3 px-4">
            {m.provider === "gmail" ? (
              <Google aria-hidden className="size-4 shrink-0" />
            ) : (
              <IconMail aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{m.address}</span>
            <span className="flex items-center gap-1.5">
              <IconCheck aria-hidden className="size-3.5" />
              Connected
            </span>
          </li>
        ))}
        {Array.from({ length: open }, (_, i) => (
          <li key={`add-${i}`}>
            <button
              type="button"
              className="group/row flex h-12 w-full items-center gap-3 px-4 text-start outline-hidden focus-visible:bg-hover"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              {/* No provider's mark until one is connected: Google is the first of several. */}
              <IconPlus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Add account</span>
              <span className="text-muted-foreground transition-colors group-hover/row:text-foreground">
                {connect.isPending ? "Opening Google…" : "Connect"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </PageForm>
  );
}

/** The domain your team gets mail on. Claiming it opens its DNS. */
function DomainEntryForm(props: { onDone: () => void }) {
  const addDomain = useAddDomain();
  const [domain, setDomain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <PageForm
      title="Use your own domain"
      description="Add the domain your team gets mail on. Your mail keeps flowing as it does today."
      submit="Continue"
      isPending={addDomain.isPending}
      problem={problem}
      onSubmit={() => {
        setProblem(null);
        if (!domain.trim()) return notify("Enter your domain, like acme.com.");
        addDomain.mutate(domain, {
          onSuccess: props.onDone,
          onError: (error) => setProblem(error.message),
        });
      }}
    >
      <TextField value={domain} onChange={setDomain} autoFocus>
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
        if (why.length > 0) setupToast(`${type} record isn't right yet`, why.join(" "));
        else
          setupToast(`${type} record not found yet`, "Still checking. DNS can take a few minutes.");
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
      title={mailOpen ? "Add the mail records" : `Verify you own ${domain.domain}`}
      description={
        <>
          Add {records.length === 1 ? "this record" : "each record"} at{" "}
          {domain.dnsHost ? <DnsHostLink host={domain.dnsHost} /> : "your DNS host"}.
          {!mailOpen && mailStage && " The mail records come next."}
        </>
      }
      submit="Continue"
      isPending={checkDomain.isPending}
      problem={problem}
      onSubmit={checkAndContinue}
    >
      {domain.domainConnect && !domainReady(domain) && (
        <Button
          intent="outline"
          className="self-center"
          isPending={rotateChallenge.isPending}
          onPress={setUpAutomatically}
        >
          <ProviderLogo name={domain.domainConnect.providerName} />
          Set up automatically with {domain.domainConnect.providerName}
        </Button>
      )}
      <DnsRecordsTable
        {...tableData(records)}
        renderValue={(record) => {
          // Omni's ownership value is kept only as a hash: in DNS already, there is nothing to copy
          // or replace; missing or wrong, the field makes a new one.
          const shown = records.find((r) => r.challenge);
          if (!shown || shown.name !== record.name || shown.value !== null) return undefined;
          return passes(shown) ? (
            <span className="text-xs/4 text-foreground">In your DNS</span>
          ) : (
            // Styled like every other value, with its action where their copy button sits:
            // the line's 12px gap, then a 26px icon button.
            <span className="flex min-w-0 items-center justify-end gap-3">
              <span className="text-xs/4 text-foreground">Hidden</span>
              <TooltipTrigger delay={300}>
                <Button
                  intent="plain"
                  size="sq-xs"
                  className="-my-px -me-1.5 text-muted-foreground *:[svg]:size-3.25 hover:text-foreground"
                  aria-label="Make a new value. It replaces the old one."
                  isPending={rotateChallenge.isPending}
                  onPress={rotate}
                >
                  <IconArrowRotateClockwise aria-hidden />
                </Button>
                <Tooltip arrow={false}>Make a new value. It replaces the old one.</Tooltip>
              </TooltipTrigger>
            </span>
          );
        }}
      />
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

function MailboxesForm(props: {
  domain: OnboardingDomain;
  /** The domain stays on its own mail host: the mailbox signs in to its servers, with its password. */
  ownHost: boolean;
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
  const [imap, setImap] = useState("");
  const [smtp, setSmtp] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const ask = props.ownHost && !saved;

  return (
    <PageForm
      title={ask ? "Connect your mailbox" : "Create your mailbox"}
      description={
        ask
          ? `${props.domain.domain} stays on its mail host. Omni signs in to it like a mail app.`
          : `The shared address your team answers from, like support@${props.domain.domain}.`
      }
      submit="Continue"
      isPending={createMailboxes.isPending}
      problem={problem}
      onSubmit={() => {
        setProblem(null);
        if (saved) return props.onDone();
        if (!name.trim()) return notify("Enter the mailbox's name.");
        if (ask && !password) return notify(`Enter the password for ${name.trim()}${suffix}.`);
        if (ask && !imap.trim()) return notify("Enter the IMAP server.");
        if (ask && !smtp.trim()) return notify("Enter the SMTP server.");
        const servers = ask ? { imap: server(imap, 993), smtp: server(smtp, 465) } : null;
        if (servers && (!servers.imap || !servers.smtp))
          return notify("Enter each server as host or host:port.");
        createMailboxes.mutate(
          {
            domainId: props.domain.id,
            mailboxes: [{ localPart: name.trim(), password }],
            ...(servers?.imap && servers.smtp
              ? { servers: { imap: servers.imap, smtp: servers.smtp } }
              : {}),
          },
          { onSuccess: props.onDone, onError: (error) => setProblem(error.message) },
        );
      }}
    >
      <div className="flex flex-col gap-2">
        <TextField value={name} onChange={setName} isReadOnly={!!saved} autoFocus>
          <Label>Address</Label>
          <InputGroup className="[--input-gutter-end:--spacing(4)]">
            <Input placeholder="name" />
            <span data-slot="text" className="text-sm text-muted-foreground">
              {suffix}
            </span>
          </InputGroup>
        </TextField>
        {ask && (
          <TextField aria-label="Password" type="password" value={password} onChange={setPassword}>
            <Input
              placeholder="Password (an app password if your host has them)"
              autoComplete="off"
            />
          </TextField>
        )}
      </div>
      {ask && (
        <>
          <TextField value={imap} onChange={setImap}>
            <Label>IMAP server</Label>
            <Input placeholder={`imap.${props.domain.domain}:993`} />
          </TextField>
          <TextField value={smtp} onChange={setSmtp}>
            <Label>SMTP server</Label>
            <Input placeholder={`smtp.${props.domain.domain}:465`} />
          </TextField>
        </>
      )}
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
function PlanForm(props: { finishing: boolean; finishProblem: string | null; onDone: () => void }) {
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
      isPending={startTrial.isPending || checkout.isPending || props.finishing}
      problem={problem ?? props.finishProblem ?? (billing.error ? billing.error.message : null)}
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
 * Invites each address into the new workspace (the existing invitation flow), or skips. On the
 * last step (no plan to pick), setup finishes and the inbox opens.
 */
function InviteForm(props: {
  finishing: boolean;
  finishProblem: string | null;
  onDone: () => void;
}) {
  const inviteMember = useInviteMember();
  // Three fields to start: most teams invite a few people at once.
  const [emails, setEmails] = useState(["", "", ""]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const typed = emails.some((e) => e.trim());

  async function submit() {
    setProblem(null);
    const wrong = emails
      .map((e) => e.trim())
      .find((e) => e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (wrong) return notify(`${wrong} isn't an email address.`);
    setSending(true);
    try {
      // Each address leaves the list once invited, so a retry after an error sends only the rest.
      for (const email of emails.map((e) => e.trim()).filter(Boolean)) {
        await inviteMember.mutateAsync({ email });
        setEmails((list) => {
          const rest = list.filter((e) => e.trim() !== email);
          return rest.length > 0 ? rest : [""];
        });
      }
      props.onDone();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <PageForm
      title="Invite your team"
      description="Add teammates by email. They'll get an invite to join."
      submit={typed ? "Send invites" : "Skip"}
      isPending={sending || props.finishing}
      problem={problem ?? props.finishProblem}
      onSubmit={() => void submit()}
      secondary={
        <Button intent="outline" onPress={() => setEmails([...emails, ""])}>
          Add another
        </Button>
      }
    >
      <InputList
        label="Emails"
        optional
        values={emails}
        onChange={setEmails}
        render={(value, set, i) => (
          <TextField
            aria-label={`Email ${i + 1}`}
            value={value}
            onChange={set}
            // The first field on arrival; a field just added after that.
            autoFocus={emails.length <= 3 ? i === 0 : i === emails.length - 1}
          >
            <Input placeholder="teammate@acme.com" />
          </TextField>
        )}
      />
    </PageForm>
  );
}

/** A labeled list of inputs; the step's "Add another" button grows it. */
function InputList(props: {
  label: string;
  optional?: boolean;
  values: string[];
  onChange: (values: string[]) => void;
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
    </div>
  );
}
