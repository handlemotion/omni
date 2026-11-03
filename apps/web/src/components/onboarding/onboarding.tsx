import { useState } from "react";
import { IconRedirectArrow } from "@/components/icons";
import { IconChevronRight } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { Step, Steps, type StepState } from "@/components/ui/steps";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";

// Set up a workspace: name it, add a domain, create its mailboxes, invite people. Layout adapted
// from the onboarding reference (Figma node 16:1400): a centered column and a step timeline.
//
// Not wired yet: each step only advances locally. The API (organization, Purelymail domain and
// mailboxes, invitations) is a separate task; hook each step's submit to it when it lands.

const STEPS = ["Workspace", "Domain", "Mailboxes", "Invite"] as const;

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState("");
  const [domain, setDomain] = useState("");
  const [mailboxes, setMailboxes] = useState([""]);
  const [invites, setInvites] = useState([""]);

  const state = (i: number): StepState =>
    i < step ? "complete" : i === step ? "current" : "upcoming";
  const last = step === STEPS.length - 1;

  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-16">
      <div className="flex w-100 max-w-full flex-col">
        <div className="flex justify-center">
          <IconRedirectArrow />
        </div>

        <nav aria-label="Setup" className="flex items-center gap-2 pt-10 text-sm">
          <span className="text-foreground">Setup</span>
          <IconChevronRight className="text-subtle-foreground" />
          <span className="text-muted-foreground">{STEPS[step]}</span>
        </nav>

        <Heading className="pt-6">Set up your workspace</Heading>
        <Text className="pt-2">
          Bring a domain and its mailboxes into Omni. Your mail keeps arriving where it does today
          until you update the domain's DNS records.
        </Text>

        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!last) setStep(step + 1);
          }}
        >
          <Steps className="pt-8">
            <Step
              state={state(0)}
              label="Step 1 · Workspace"
              title={step > 0 && workspace ? workspace : "Name your workspace"}
              description={step === 0 ? "Usually your company or team." : undefined}
            >
              {step === 0 && (
                <TextField value={workspace} onChange={setWorkspace} isRequired autoFocus>
                  <Label>Workspace name</Label>
                  <Input placeholder="Acme" />
                </TextField>
              )}
            </Step>

            <Step
              state={state(1)}
              label="Step 2 · Domain"
              title={step > 1 && domain ? domain : "Add your domain"}
              description={
                step === 1
                  ? "Next you'll see the DNS records (MX, SPF, DKIM, DMARC) to add at your registrar."
                  : undefined
              }
            >
              {step === 1 && (
                <TextField value={domain} onChange={setDomain} isRequired autoFocus>
                  <Label>Domain</Label>
                  <Input placeholder="acme.com" />
                </TextField>
              )}
            </Step>

            <Step
              state={state(2)}
              label="Step 3 · Mailboxes"
              title="Create mailboxes"
              description={
                step === 2 ? "One per person, plus shared ones like hello@ or support@." : undefined
              }
            >
              {step === 2 && (
                <List
                  values={mailboxes}
                  onChange={setMailboxes}
                  addLabel="Add mailbox"
                  render={(value, set, i) => (
                    <TextField
                      aria-label={`Mailbox ${i + 1}`}
                      value={value}
                      onChange={set}
                      isRequired={i === 0}
                      autoFocus={i === mailboxes.length - 1}
                    >
                      <InputGroup className="[--input-gutter-end:--spacing(4)]">
                        <Input placeholder="name" />
                        <span data-slot="text" className="text-sm text-muted-foreground">
                          @{domain || "acme.com"}
                        </span>
                      </InputGroup>
                    </TextField>
                  )}
                />
              )}
            </Step>

            <Step
              state={state(3)}
              label="Step 4 · Invite"
              title="Invite your team"
              description={
                step === 3 ? "They'll get an email to join. You can skip this." : undefined
              }
            >
              {step === 3 && (
                <List
                  values={invites}
                  onChange={setInvites}
                  addLabel="Add person"
                  render={(value, set, i) => (
                    <TextField
                      aria-label={`Email ${i + 1}`}
                      type="email"
                      value={value}
                      onChange={set}
                      autoFocus={i === invites.length - 1}
                    >
                      <Input placeholder="teammate@acme.com" />
                    </TextField>
                  )}
                />
              )}
            </Step>
          </Steps>

          <Button type="submit" size="lg" className="mt-10 w-full">
            {last ? "Finish setup" : "Continue"}
            <IconChevronRight />
          </Button>
        </form>

        {step > 0 && (
          <Button
            intent="plain"
            className="mt-3 self-center text-muted-foreground"
            onPress={() => setStep(step - 1)}
          >
            Back
          </Button>
        )}
      </div>
    </main>
  );
}

/** A growing list of inputs with an "add another" action. */
function List(props: {
  values: string[];
  onChange: (values: string[]) => void;
  addLabel: string;
  render: (value: string, set: (value: string) => void, index: number) => React.ReactNode;
}) {
  const { values, onChange } = props;
  return (
    <div className="flex flex-col gap-2">
      {values.map((value, i) => (
        <div key={i}>
          {props.render(value, (next) => onChange(values.map((v, j) => (j === i ? next : v))), i)}
        </div>
      ))}
      <Button
        intent="plain"
        size="xs"
        className="self-start px-0 text-muted-foreground"
        onPress={() => onChange([...values, ""])}
      >
        + {props.addLabel}
      </Button>
    </div>
  );
}
