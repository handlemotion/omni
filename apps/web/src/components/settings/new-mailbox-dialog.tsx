import { useState } from "react";
import { Label } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useCreateMailboxes } from "@/hooks/use-onboarding.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useCreateSharedInbox, useIssueInbox } from "@/hooks/use-workspace-admin.ts";
import { usePersonalWorkspace } from "@/hooks/use-workspaces.ts";
import { type MailServer, parseServer } from "@/lib/onboarding.ts";
import type { OnboardingDomain } from "@/lib/types.ts";
import { useMailboxDomains } from "./mailbox-pages";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";

const localPartOf = (email: string) => email.split("@")[0] ?? "";

/** The person a new personal inbox is for, as People lists them. */
export interface InboxOwner {
  id: string;
  name: string;
  email: string;
  /** The signed-in member, making their own. */
  isYou: boolean;
}

interface Placement {
  domainId: string;
  localPart: string;
  password?: string;
  servers?: { imap: MailServer; smtp: MailServer };
}

function useCreateInbox(person: InboxOwner | undefined) {
  const { member } = useMember();
  const issue = useIssueInbox();
  const createShared = useCreateSharedInbox();
  const own = usePersonalWorkspace() && person?.isYou === true;
  const createOwn = useCreateMailboxes();
  const run = (
    placement: Placement,
    done: { onSuccess: (made: { address: string }) => void; onError: (error: Error) => void },
  ) => {
    if (own) {
      const { domainId, localPart, password, servers } = placement;
      return createOwn.mutate(
        { domainId, mailboxes: [{ localPart, password }], servers },
        { onSuccess: ([made]) => made && done.onSuccess(made), onError: done.onError },
      );
    }
    if (person) return issue.mutate({ ...placement, memberId: person.id }, done);
    createShared.mutate({ ...placement, memberIds: [member.id] }, done);
  };
  const pending = (own ? createOwn : person ? issue : createShared).isPending;
  return { run, isPending: pending };
}

/**
 * Creates a mailbox on one of the workspace's domains (the setup route): a shared one,
 * or `person`'s personal inbox that only they will see. A personal inbox starts as their sign-in
 * address when its domain is one of these. On the workspace's own mail host it needs the
 * mailbox's existing password and servers, as in setup.
 */
export function NewMailboxDialog(props: {
  domains: OnboardingDomain[];
  person?: InboxOwner;
  /** The domain to start on, over the sign-in address's. */
  domainId?: string;
  onClose: () => void;
}) {
  const { person } = props;
  const create = useCreateInbox(person);
  const signInDomain = person?.email.split("@")[1]?.toLowerCase();
  const [domainId, setDomainId] = useState(
    (
      props.domains.find((d) => d.id === props.domainId) ??
      props.domains.find((d) => d.domain.toLowerCase() === signInDomain) ??
      props.domains[0]!
    ).id,
  );
  const [localPart, setLocalPart] = useState(person ? localPartOf(person.email) : "");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState("");
  const [smtp, setSmtp] = useState("");
  const domain = props.domains.find((d) => d.id === domainId) ?? props.domains[0]!;
  const ownHost = domain.provider === "imap";
  const servers = ownHost ? { imap: parseServer(imap, 993), smtp: parseServer(smtp, 465) } : null;
  const ready =
    localPart.trim() !== "" && (!servers || (!!password && !!servers.imap && !!servers.smtp));

  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={
        !person ? "Add a shared mailbox" : person.isYou ? "Create your inbox" : "Create an inbox"
      }
      description={
        !person
          ? "You can choose who sees it next."
          : person.isYou
            ? "Only you will see it."
            : `Only ${person.name} will see it. You won't.`
      }
      action={person ? "Create" : "Add"}
      disabled={!ready}
      saving={create.isPending}
      onSubmit={() => {
        const placement = {
          domainId: domain.id,
          localPart: localPart.trim(),
          ...(ownHost && servers?.imap && servers.smtp
            ? { password, servers: { imap: servers.imap, smtp: servers.smtp } }
            : {}),
        };
        const done = {
          onSuccess: (made: { address: string }) => {
            props.onClose();
            appToast.success(
              !person
                ? `Added ${made.address}`
                : person.isYou
                  ? `Created ${made.address}`
                  : `Created ${made.address} for ${person.name}`,
            );
          },
          onError: (error: Error) =>
            appToast.error(error.message || "The mailbox was not created."),
        };
        create.run(placement, done);
      }}
    >
      {props.domains.length > 1 && (
        <Select value={domainId} onChange={(next) => next && setDomainId(String(next))}>
          <Label>Domain</Label>
          <SelectTrigger />
          <SelectContent items={props.domains}>
            {(d) => (
              <SelectItem id={d.id} textValue={d.domain}>
                {d.domain}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
      <TextField isRequired autoFocus value={localPart} onChange={setLocalPart}>
        <Label>Address</Label>
        <InputGroup className="[--input-gutter-end:--spacing(4)]">
          <Input placeholder={person ? "name" : "hello"} autoComplete="off" />
          <span data-slot="text" className="text-sm text-muted-foreground">
            @{domain.domain}
          </span>
        </InputGroup>
      </TextField>
      {ownHost && (
        <>
          <TextField type="password" isRequired value={password} onChange={setPassword}>
            <Label>Password</Label>
            <Input autoComplete="off" />
          </TextField>
          <TextField isRequired value={imap} onChange={setImap}>
            <Label>IMAP server</Label>
            <Input placeholder={`imap.${domain.domain}:993`} autoComplete="off" />
          </TextField>
          <TextField isRequired value={smtp} onChange={setSmtp}>
            <Label>SMTP server</Label>
            <Input placeholder={`smtp.${domain.domain}:465`} autoComplete="off" />
          </TextField>
        </>
      )}
    </SettingsFormDialog>
  );
}

/**
 * In a Personal space, its owner creates their own inboxes on its domains: `open()`
 * shows the dialog, `dialog` renders it. In a company that is People's, for owners and admins.
 */
export function useOwnInboxCreation(domainId?: string) {
  const { user, member } = useMember();
  const personal = usePersonalWorkspace();
  const domains = useMailboxDomains() ?? [];
  const [isOpen, setOpen] = useState(false);
  return {
    personal,
    domains,
    open: () => setOpen(true),
    dialog: isOpen && domains.length > 0 && (
      <NewMailboxDialog
        domains={domains}
        domainId={domainId}
        person={{ id: member.id, name: user.name, email: user.email, isYou: true }}
        onClose={() => setOpen(false)}
      />
    ),
  };
}
