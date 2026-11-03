import { DocumentDuplicateIcon } from "@heroicons/react/24/outline";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { IconRedirectArrow } from "@/components/icons";
import { IconChevronRight } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { Note } from "@/components/ui/note";
import { Step, Steps, type StepState } from "@/components/ui/steps";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import {
  useAddDomain,
  useCheckDomain,
  useCreateMailboxes,
  useCreateWorkspace,
  useOnboarding,
} from "@/hooks/use-onboarding";
import { useInviteMember } from "@/hooks/use-organization";
import { needsSetup } from "@/lib/onboarding";
import type { DnsRecord, OnboardingDomain } from "@/lib/types";

// Workspace setup, one short form per page (layout from the Figma references 16:1400 and
// 25:1509, on our tokens). Only DNS uses steps: each record is checked before the next.
//
// Each page calls the API (ADR 0007). A workspace that exists but has no mailboxes resumes where
// it stopped. Without Purelymail the domain stays on its mail host: the DNS page asks for that
// host's servers instead, and each mailbox is added with its existing password.

const PAGES = ["Workspace", "DNS", "Mailboxes", "Invite"] as const;

/** `host` or `host:port`; the port defaults to the implicit-TLS one. */
function server(value: string, defaultPort: number) {
  const match = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(value);
  if (!match) return null;
  return { host: match[1]!, port: match[2] ? Number(match[2]) : defaultPort };
}

type Servers = { imap: { host: string; port: number }; smtp: { host: string; port: number } };

export function Onboarding() {
  const status = useOnboarding();
  // Decided once, from what the route loaded: finish the active workspace, or start a new one.
  const [resuming, setResuming] = useState(() => (status.data ? needsSetup(status.data) : false));
  const [page, setPage] = useState(() => (resuming && status.data?.domains[0] ? 1 : 0));
  const [servers, setServers] = useState<Servers | null>(null);
  // Only the workspace being set up: a new one has no domain until page 0 adds it.
  const domain = resuming ? status.data?.domains[0] : undefined;
  const ownHost = domain?.provider === "imap";
  const next = () => setPage((p) => Math.min(p + 1, PAGES.length - 1));
  // Never back onto page 0: the workspace and domain it saved stay saved.
  const back = page > 1 ? () => setPage(page - 1) : undefined;
  const names = ownHost ? PAGES.map((n) => (n === "DNS" ? "Mail server" : n)) : PAGES;

  return (
    <OnboardingPage page={page} names={names} onBack={back}>
      {page === 0 && (
        <WorkspaceForm
          existing={resuming ? status.data?.organization?.name : undefined}
          onDone={() => {
            setResuming(true);
            next();
          }}
        />
      )}
      {page === 1 && domain && !ownHost && <DnsForm domain={domain} onDone={next} />}
      {page === 1 && domain && ownHost && (
        <ServerForm
          domain={domain.domain}
          onDone={(s) => {
            setServers(s);
            next();
          }}
        />
      )}
      {page === 2 && domain && (
        <MailboxesForm domain={domain} servers={ownHost ? servers : null} onDone={next} />
      )}
      {page === 3 && <InviteForm domain={domain?.domain} />}
    </OnboardingPage>
  );
}

/** The frame every page shares: logo, step progress, then the page's form. */
function OnboardingPage(props: {
  page: number;
  names: readonly string[];
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-16">
      <div className="flex w-100 max-w-full flex-col">
        <div className="flex justify-center">
          <IconRedirectArrow />
        </div>
        <StepProgress current={props.page} names={props.names} />
        {props.children}
        {props.onBack && (
          <Button
            intent="plain"
            className="mt-3 self-center text-muted-foreground"
            onPress={props.onBack}
          >
            Back
          </Button>
        )}
      </div>
    </main>
  );
}

/** "Step 2 of 4 · DNS" over one bar per step, filled through the current one. */
function StepProgress(props: { current: number; names: readonly string[] }) {
  const { current, names } = props;
  return (
    <div className="flex flex-col gap-2 pt-12">
      <span className="text-sm text-muted-foreground">
        Step {current + 1} of {names.length}
        <span className="text-subtle-foreground"> · </span>
        <span className="text-foreground">{names[current]}</span>
      </span>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={names.length}
        aria-valuenow={current + 1}
        aria-valuetext={`Step ${current + 1} of ${names.length}: ${names[current]}`}
        className="flex gap-1"
      >
        {names.map((name, i) => (
          <span
            key={name}
            className={`h-1 flex-1 rounded-full ${i <= current ? "bg-foreground" : "bg-border"}`}
          />
        ))}
      </div>
    </div>
  );
}

/** Heading, an optional one-line description, the fields, and the submit button. */
function PageForm(props: {
  title: string;
  description?: string;
  submit: string;
  isDisabled?: boolean;
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
      </div>
      <div className="flex flex-col gap-6 pt-8">{props.children}</div>
      {props.problem && (
        <Note intent="danger" className="mt-6" role="alert">
          {props.problem}
        </Note>
      )}
      <Button
        type="submit"
        size="lg"
        className="mt-10 w-full"
        isDisabled={props.isDisabled}
        isPending={props.isPending}
      >
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

/** What each Purelymail check is for. Ownership comes first: Purelymail adds the domain only then. */
const PURPOSES: { check: DnsRecord["check"]; purpose: string }[] = [
  { check: "ownership", purpose: "Prove you own it" },
  { check: "mx", purpose: "Receive mail" },
  { check: "spf", purpose: "Allow sending (SPF)" },
  { check: "dkim", purpose: "Sign outgoing mail (DKIM)" },
  { check: "dmarc", purpose: "Set a policy (DMARC)" },
];

function DnsForm(props: { domain: OnboardingDomain; onDone: () => void }) {
  const checkDomain = useCheckDomain();
  const [problem, setProblem] = useState<string | null>(null);
  const { domain } = props;
  const groups = PURPOSES.map((p) => ({
    ...p,
    records: domain.records.filter((r) => r.check === p.check),
  })).filter((g) => g.records.length > 0);
  const current = groups.findIndex((g) => !g.records.every((r) => r.verified));
  const state = (i: number): StepState =>
    current === -1 || i < current ? "complete" : i === current ? "current" : "upcoming";
  const check = () => {
    setProblem(null);
    checkDomain.mutate(domain.id, { onError: (error) => setProblem(error.message) });
  };

  return (
    <PageForm
      title="Connect your domain"
      description={`Add each record at the registrar for ${domain.domain}.`}
      submit="Continue"
      isDisabled={current !== -1}
      problem={problem}
      onSubmit={props.onDone}
    >
      <Steps>
        {groups.map((group, i) => (
          <Step
            key={group.check}
            state={state(i)}
            label={group.records[0]!.type}
            title={group.purpose}
          >
            <div className="flex flex-col gap-2">
              {group.records.map((record) => (
                <div key={record.name} className="flex flex-col gap-2">
                  <RecordField label="Name" value={record.name} />
                  <RecordField
                    label="Value"
                    value={
                      record.priority !== undefined
                        ? `${record.priority} ${record.value}`
                        : record.value
                    }
                  />
                </div>
              ))}
              {group.check === "ownership" && domain.addError && <Text>{domain.addError}</Text>}
              <Button
                intent="outline"
                className="mt-1 self-start"
                isPending={checkDomain.isPending}
                onPress={check}
              >
                Check record
              </Button>
            </div>
          </Step>
        ))}
      </Steps>
    </PageForm>
  );
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

function RecordField({ label, value }: { label: string; value?: string }) {
  return (
    <TextField aria-label={label} value={value ?? ""} isReadOnly>
      <InputGroup className="[--input-gutter-end:--spacing(8)]">
        <Input placeholder={`${label} appears once the domain is added`} />
        <Button
          intent="plain"
          size="sq-xs"
          aria-label={`Copy ${label.toLowerCase()}`}
          isDisabled={!value}
          onPress={() => value && void navigator.clipboard.writeText(value)}
        >
          <DocumentDuplicateIcon />
        </Button>
      </InputGroup>
    </TextField>
  );
}

function MailboxesForm(props: {
  domain: OnboardingDomain;
  /** Set on the bring-your-own-host path: each mailbox then needs its password. */
  servers: Servers | null;
  onDone: () => void;
}) {
  const createMailboxes = useCreateMailboxes();
  const [names, setNames] = useState([""]);
  const [passwords, setPasswords] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const { servers } = props;

  return (
    <PageForm
      title="Create mailboxes"
      description={
        servers ? "Each with its password (an app password if your host has them)." : undefined
      }
      submit="Continue"
      isPending={createMailboxes.isPending}
      problem={problem}
      onSubmit={() => {
        setProblem(null);
        createMailboxes.mutate(
          {
            domainId: props.domain.id,
            mailboxes: names
              .map((localPart, i) => ({
                localPart: localPart.trim(),
                password: passwords[i] ?? "",
              }))
              .filter((m) => m.localPart),
            ...(servers ? { servers } : {}),
          },
          { onSuccess: props.onDone, onError: (error) => setProblem(error.message) },
        );
      }}
    >
      <InputList
        label="Addresses"
        values={names}
        onChange={setNames}
        addLabel="Add mailbox"
        render={(value, set, i) => (
          <div className="flex flex-col gap-2">
            <TextField
              aria-label={`Address ${i + 1}`}
              value={value}
              onChange={set}
              isRequired={i === 0}
              autoFocus={i === names.length - 1}
            >
              <InputGroup className="[--input-gutter-end:--spacing(4)]">
                <Input placeholder="name" />
                <span data-slot="text" className="text-sm text-muted-foreground">
                  @{props.domain.domain}
                </span>
              </InputGroup>
            </TextField>
            {servers && (
              <TextField
                aria-label={`Password for address ${i + 1}`}
                type="password"
                value={passwords[i] ?? ""}
                onChange={(next) =>
                  setPasswords((all) => {
                    const copy = [...all];
                    copy[i] = next;
                    return copy;
                  })
                }
                isRequired={value.trim() !== ""}
              >
                <Input placeholder="Password" autoComplete="off" />
              </TextField>
            )}
          </div>
        )}
      />
    </PageForm>
  );
}

/** Invites each address into the new workspace (the existing invitation flow), then opens the inbox. */
function InviteForm(props: { domain?: string }) {
  const navigate = useNavigate();
  const inviteMember = useInviteMember();
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
