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
  useRemoveDomain,
  useRotateChallenge,
} from "@/hooks/use-onboarding";
import { useBilling, useStartCheckout, useStartTrial } from "@/hooks/use-billing";
import {
  useConnectGoogle,
  useGoogleAccounts,
  useGoogleReturn,
} from "@/hooks/use-google-connection";
import { useInviteWithInbox } from "@/hooks/use-workspace-admin";
import { formatPrice, type Interval } from "@/lib/billing";
import { googleErrorText, type GoogleOutcome } from "@/lib/google-connection";
import {
  needsSetup,
  onboardingPages,
  PAGE_TITLES,
  parseServer as server,
  challengePasses,
  domainReady,
  recordPasses,
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

export function Onboarding() {
  const status = useOnboarding();
  const google = useGoogleAccounts();
  const googleReturn = useGoogleReturn();
  const [resuming, setResuming] = useState(() => needsSetup(status.data?.organization));
  const data = resuming ? status.data : undefined;
  const pages = onboardingPages(status.data);
  const [page, setPage] = useState<OnboardingPage>(() => {
    if (!resuming || !status.data) return "Workspace";
    return googleReturn ? "Inbox" : resumePage(status.data);
  });
  const [domainId, setDomainId] = useState<string>();
  const domains = data?.domains ?? [];
  const domain = domains.find((d) => d.id === domainId) ?? domains.at(-1);
  const finish = useFinish();
  const index = pages.indexOf(page);
  const next = () => {
    const after = pages[index + 1];
    if (after) setPage(after);
    else finish.run();
  };
  const previous = pages[index - 1];
  const navigate = useNavigate();
  const inWorkspace = !!useSession().data?.member;
  const back = previous
    ? () => setPage(previous)
    : inWorkspace
      ? undefined
      : () => void navigate({ to: "/welcome" });
  const chooseDomain = (id: string) => {
    setDomainId(id);
    next();
  };

  return (
    <OnboardingPage pages={pages} current={page} onBack={back}>
      <Step
        page={page}
        data={data}
        domain={domain}
        googleAvailable={google.data?.available === true}
        googleReturn={googleReturn}
        finish={finish}
        workspaceName={resuming ? status.data?.organization?.name : undefined}
        onWorkspace={() => {
          setResuming(true);
          next();
        }}
        onDomain={chooseDomain}
        onDone={next}
      />
    </OnboardingPage>
  );
}

function Step(props: {
  page: OnboardingPage;
  data: OnboardingStatus | undefined;
  domain: OnboardingDomain | undefined;
  googleAvailable: boolean;
  googleReturn: GoogleOutcome | null;
  finish: ReturnType<typeof useFinish>;
  workspaceName: string | undefined;
  onWorkspace: () => void;
  onDomain: (domainId: string) => void;
  onDone: () => void;
}) {
  const { domain, finish } = props;
  switch (props.page) {
    case "Workspace":
      return <WorkspaceForm existing={props.workspaceName} onDone={props.onWorkspace} />;
    case "Domain":
      return (
        <DomainStep
          key={domain?.id ?? "new"}
          domain={domain}
          googleAvailable={props.googleAvailable}
          onDone={props.onDomain}
        />
      );
    case "Records":
      return domain ? (
        <DomainForm
          domain={domain}
          organizationId={props.data?.organization?.id ?? ""}
          onDone={props.onDone}
        />
      ) : (
        <DomainStep
          domain={undefined}
          googleAvailable={props.googleAvailable}
          onDone={props.onDomain}
        />
      );
    case "Inbox":
      return (
        <InboxStep
          domain={domain}
          mailboxes={props.data?.mailboxes ?? []}
          googleReturn={props.googleReturn}
          onDone={props.onDone}
        />
      );
    case "Team":
      return (
        <InviteForm
          finishing={finish.isPending}
          finishProblem={finish.problem}
          onDone={props.onDone}
        />
      );
    case "Plan":
      return pageDone("Plan", props.data) ? (
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
        <PlanForm finishing={finish.isPending} finishProblem={finish.problem} onDone={finish.run} />
      );
  }
}

function useFinish() {
  const navigate = useNavigate();
  const finishSetup = useFinishSetup();
  return {
    run: () => finishSetup.mutate(undefined, { onSuccess: () => void navigate({ to: "/" }) }),
    isPending: finishSetup.isPending || finishSetup.isSuccess,
    problem: finishSetup.error?.message ?? null,
  };
}

const BackContext = createContext<(() => void) | undefined>(undefined);

const notify = (message: string) => setupToast(message);

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
        className="h-7 max-w-60 min-w-0 justify-start gap-2.5 rounded-sm px-1.5 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
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

function PageForm(props: {
  title: string;
  description?: ReactNode;
  submit: string;
  secondary?: ReactNode;
  isPending?: boolean;
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

const keepsHost = (d: OnboardingDomain) => d.provider === "imap" || d.provider === "gmail";

type Host = "google" | "omni";

const plainDomain = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");

function DomainStep(props: {
  domain: OnboardingDomain | undefined;
  googleAvailable: boolean;
  onDone: (domainId: string) => void;
}) {
  const addDomain = useAddDomain();
  const removeDomain = useRemoveDomain();
  const current = props.domain;
  const [text, setText] = useState(current?.domain ?? "");
  const [chosen, setHost] = useState<Host>();
  const host: Host =
    chosen ??
    (current
      ? current.provider === "gmail"
        ? "google"
        : "omni"
      : props.googleAvailable
        ? "google"
        : "omni");
  const pending = addDomain.isPending || removeDomain.isPending;

  const submit = async () => {
    const name = plainDomain(text);
    if (!name) return notify("Enter your domain, like acme.com.");
    const currentHost: Host | undefined = current
      ? current.provider === "gmail"
        ? "google"
        : "omni"
      : undefined;
    if (current && name === current.domain && host === currentHost) return props.onDone(current.id);
    if (current && name === current.domain && current.status === "verified") {
      return notify(
        `${name} is already set up. Remove it in Settings to change where its mail is.`,
      );
    }
    try {
      if (current && current.status !== "verified") await removeDomain.mutateAsync(current.id);
      const added = await addDomain.mutateAsync(
        host === "google" ? { domain: name, host: "gmail" } : name,
      );
      props.onDone(added.id);
    } catch (error) {
      notify((error as Error).message || "The domain could not be added.");
    }
  };

  return (
    <PageForm
      title="Your company's domain"
      submit="Continue"
      isPending={pending}
      onSubmit={() => void submit()}
    >
      <TextField value={text} onChange={setText} autoFocus>
        <Label>Domain</Label>
        <Input placeholder="acme.com" />
      </TextField>
      {props.googleAvailable && (
        <ChoiceBox
          aria-label="Where its mail is"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[host]}
          onSelectionChange={(keys) => {
            const [key] = [...(keys as Set<Key>)];
            if (key === "google" || key === "omni") setHost(key);
          }}
          items={[
            { id: "google", label: "Google Workspace" },
            { id: "omni", label: "Omni" },
          ]}
        >
          {(item) => <ChoiceBoxItem id={item.id} label={item.label} />}
        </ChoiceBox>
      )}
    </PageForm>
  );
}

const googleProblem = (outcome: GoogleOutcome | null) =>
  outcome?.kind === "error" ? googleErrorText(outcome.reason) : null;

function InboxStep(props: {
  domain: OnboardingDomain | undefined;
  mailboxes: OnboardingStatus["mailboxes"];
  googleReturn: GoogleOutcome | null;
  onDone: () => void;
}) {
  const { domain } = props;
  useGoogleElsewhere(props.googleReturn, props.mailboxes, domain?.domain);
  if (domain && domain.provider !== "gmail") {
    return (
      <MailboxesForm
        domain={domain}
        ownHost={domain.provider === "imap"}
        created={props.mailboxes}
        onDone={props.onDone}
      />
    );
  }
  return (
    <ConnectInboxForm
      mailboxes={props.mailboxes}
      problem={googleProblem(props.googleReturn)}
      onDone={props.onDone}
    />
  );
}

function useGoogleElsewhere(
  outcome: GoogleOutcome | null,
  mailboxes: OnboardingStatus["mailboxes"],
  domain: string | undefined,
) {
  const [told, setTold] = useState(false);
  const id = outcome?.kind === "connected" ? outcome.mailboxId : null;
  useEffect(() => {
    if (told || !id || mailboxes.some((m) => m.id === id)) return;
    setTold(true);
    setupToast(
      "Added to your Personal space",
      domain
        ? `That account isn't on ${domain}, so it opens in your Personal space, not this workspace.`
        : "That account isn't on your company's domain, so it opens in your Personal space.",
    );
  }, [told, id, mailboxes, domain]);
}

function ConnectInboxForm(props: {
  mailboxes: OnboardingStatus["mailboxes"];
  problem: string | null;
  onDone: () => void;
}) {
  const connect = useConnectGoogle("onboarding");
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

const PURPOSES: { check: DnsRecord["check"]; purpose: string }[] = [
  { check: "ownership", purpose: "Prove you own it" },
  { check: "mx", purpose: "Receive mail" },
  { check: "spf", purpose: "Allow sending (SPF)" },
  { check: "dkim", purpose: "Sign outgoing mail (DKIM)" },
  { check: "dmarc", purpose: "Set a policy (DMARC)" },
];

type Diagnostic = NonNullable<DnsRecord["diagnostic"]>;

interface ShownRecord {
  check: DnsRecord["check"];
  type: DnsRecord["type"];
  name: string;
  value: string | null;
  priority?: number;
  verified: boolean;
  challenge?: boolean;
  diagnostic: Diagnostic | null;
}

const passes = (r: ShownRecord) => recordPasses(r);

function shownRecords(domain: OnboardingDomain) {
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
  const shown: ShownRecord[] = [...challenge, ...domain.records];
  return shown;
}

function recordGroups(domain: OnboardingDomain) {
  const records = shownRecords(domain);
  const groups = PURPOSES.map((p) => ({
    ...p,
    records: records.filter((r) => r.check === p.check),
  })).filter((g) => g.records.length > 0);
  return { groups, current: groups.findIndex((g) => !g.records.every(passes)) };
}

function groupProblems(
  domain: OnboardingDomain,
  group: ReturnType<typeof recordGroups>["groups"][number],
) {
  return [
    ...(group.check === "ownership" && domain.addError ? [domain.addError] : []),
    ...group.records
      .filter((r) => r.diagnostic && !passes(r) && r.diagnostic.status !== "missing")
      .map((r) => diagnosticText(r.diagnostic!)),
  ];
}

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
  const mailStage = !keepsHost(domain) || mailRecords.length > 0;
  useRealtimeConnection(props.organizationId);
  useDomainWatch(domain.id, !domainReady(domain));
  const checkAndContinue = () => {
    setProblem(null);
    if (domainReady(domain) && domain.provider !== "imap") return props.onDone();
    checkDomain.mutate(domain.id, {
      onSuccess: (fresh) => {
        if (domainReady(fresh)) return props.onDone();
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
          const shown = records.find((r) => r.challenge);
          if (!shown || shown.name !== record.name || shown.value !== null) return undefined;
          return passes(shown) ? (
            <span className="text-xs/4 text-foreground">In your DNS</span>
          ) : (
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

function tableData(records: ShownRecord[]) {
  const rows = records.map((record) => {
    const done = passes(record);
    const wrong = !done && !!record.diagnostic && record.diagnostic.status !== "missing";
    const row: TableRecord = {
      type: record.type,
      name: record.name,
      value:
        record.value === null
          ? ""
          : (record.diagnostic?.suggestion ??
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
  } satisfies { records: TableRecord[]; issues: DomainIssue[] };
}

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

const PROVIDER_LOGOS: Record<string, typeof Cloudflare> = { Cloudflare };

function ProviderLogo(props: { name: string }) {
  const Logo = PROVIDER_LOGOS[props.name];
  return Logo ? <Logo width={15} height={15} aria-hidden /> : null;
}

function diagnosticText({ message, found }: Diagnostic) {
  return found.length > 0 ? `${message} Found: ${found.join(", ")}` : message;
}

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
  ownHost: boolean;
  created: { address: string }[];
  onDone: () => void;
}) {
  const createMailboxes = useCreateMailboxes();
  const suffix = `@${props.domain.domain}`;
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

const SAMPLE_CHOICES = [
  { id: "month", label: "Monthly", description: "$19 a month" },
  { id: "year", label: "Yearly", description: "$190 a year, 2 months free" },
] as const;

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

function InviteForm(props: {
  finishing: boolean;
  finishProblem: string | null;
  onDone: () => void;
}) {
  const invite = useInviteWithInbox();
  const setup = useOnboarding().data;
  const hosted = setup?.domains.find(
    (d) => d.provider === "purelymail" && d.status === "verified" && d.added,
  );
  const sharedInboxIds = hosted
    ? []
    : (setup?.mailboxes ?? []).filter((m) => m.kind === "shared").map((m) => m.id);
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
      for (const email of emails.map((e) => e.trim()).filter(Boolean)) {
        const localPart = email.split("@")[0] ?? "";
        await invite.mutateAsync({
          email,
          ...(hosted && localPart ? { inbox: { domainId: hosted.id, localPart } } : {}),
          sharedInboxIds,
        });
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
            autoFocus={emails.length <= 3 ? i === 0 : i === emails.length - 1}
          >
            <Input placeholder="teammate@acme.com" />
          </TextField>
        )}
      />
    </PageForm>
  );
}

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
