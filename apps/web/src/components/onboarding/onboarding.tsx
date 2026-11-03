import { DocumentDuplicateIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import { IconRedirectArrow } from "@/components/icons";
import { IconChevronRight } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { Step, Steps, type StepState } from "@/components/ui/steps";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";

// Workspace setup, one short form per page (layout from the Figma references 16:1400 and
// 25:1509, on our tokens). Only DNS uses steps: each record is checked before the next.
//
// Not wired yet: forms advance on local state and DNS records have no values. The API
// (organization, Purelymail domain, records and checks, mailboxes, invitations) is a separate task;
// replace the local state with its hooks.

const PAGES = ["Workspace", "DNS", "Mailboxes", "Invite"] as const;

export function Onboarding() {
  const [page, setPage] = useState(0);
  const [domain, setDomain] = useState("");
  const next = () => setPage((p) => Math.min(p + 1, PAGES.length - 1));
  const back = page > 0 ? () => setPage(page - 1) : undefined;

  return (
    <OnboardingPage page={page} onBack={back}>
      {page === 0 && <WorkspaceForm domain={domain} setDomain={setDomain} onDone={next} />}
      {page === 1 && <DnsForm domain={domain} onDone={next} />}
      {page === 2 && <MailboxesForm domain={domain} onDone={next} />}
      {page === 3 && <InviteForm onDone={() => {}} />}
    </OnboardingPage>
  );
}

/** The frame every page shares: logo, step progress, then the page's form. */
function OnboardingPage(props: { page: number; onBack?: () => void; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-16">
      <div className="flex w-100 max-w-full flex-col">
        <div className="flex justify-center">
          <IconRedirectArrow />
        </div>
        <StepProgress current={props.page} names={PAGES} />
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
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5 pt-8">
        <Heading>{props.title}</Heading>
        {props.description && <Text>{props.description}</Text>}
      </div>
      <div className="flex flex-col gap-6 pt-8">{props.children}</div>
      <Button type="submit" size="lg" className="mt-10 w-full" isDisabled={props.isDisabled}>
        {props.submit}
        <IconChevronRight />
      </Button>
    </form>
  );
}

function WorkspaceForm(props: {
  domain: string;
  setDomain: (d: string) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <PageForm
      title="Set up your workspace"
      description="Mail keeps flowing as it does today until DNS changes."
      submit="Continue"
      onSubmit={props.onDone}
    >
      <TextField value={name} onChange={setName} isRequired autoFocus>
        <Label>Workspace name</Label>
        <Input placeholder="Acme" />
      </TextField>
      <TextField value={props.domain} onChange={props.setDomain} isRequired>
        <Label>Domain</Label>
        <Input placeholder="acme.com" />
      </TextField>
    </PageForm>
  );
}

/** One DNS record to add. Name and value come from the mail host once the domain exists. */
interface DnsRecord {
  type: "MX" | "TXT" | "CNAME";
  purpose: string;
  name?: string;
  value?: string;
  verified: boolean;
}

const RECORDS: DnsRecord[] = [
  { type: "MX", purpose: "Receive mail", verified: false },
  { type: "TXT", purpose: "Allow sending (SPF)", verified: false },
  { type: "CNAME", purpose: "Sign outgoing mail (DKIM)", verified: false },
  { type: "TXT", purpose: "Set a policy (DMARC)", verified: false },
];

function DnsForm(props: { domain: string; onDone: () => void }) {
  const records = RECORDS;
  const current = records.findIndex((r) => !r.verified);
  const state = (i: number): StepState =>
    current === -1 || i < current ? "complete" : i === current ? "current" : "upcoming";

  return (
    <PageForm
      title="Connect your domain"
      description={`Add each record at the registrar for ${props.domain || "your domain"}.`}
      submit="Continue"
      isDisabled={current !== -1}
      onSubmit={props.onDone}
    >
      <Steps>
        {records.map((record, i) => (
          <Step key={record.purpose} state={state(i)} label={record.type} title={record.purpose}>
            <div className="flex flex-col gap-2">
              <RecordField label="Name" value={record.name} />
              <RecordField label="Value" value={record.value} />
              {/* Checking needs the API; until then the step can't complete. */}
              <Button intent="outline" className="mt-1 self-start" isDisabled>
                Check record
              </Button>
            </div>
          </Step>
        ))}
      </Steps>
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

function MailboxesForm(props: { domain: string; onDone: () => void }) {
  const [names, setNames] = useState([""]);
  return (
    <PageForm title="Create mailboxes" submit="Continue" onSubmit={props.onDone}>
      <InputList
        label="Addresses"
        values={names}
        onChange={setNames}
        addLabel="Add mailbox"
        render={(value, set, i) => (
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
                @{props.domain || "acme.com"}
              </span>
            </InputGroup>
          </TextField>
        )}
      />
    </PageForm>
  );
}

function InviteForm(props: { onDone: () => void }) {
  const [emails, setEmails] = useState([""]);
  return (
    <PageForm title="Invite your team" submit="Finish setup" onSubmit={props.onDone}>
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
            <Input placeholder="teammate@acme.com" />
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
