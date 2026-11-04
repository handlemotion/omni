// Settings pages about the workspace's mailboxes, one question each:
// - Your mailboxes: what you can open here and how full each inbox is. Facts only.
// - Shared mailboxes: every shared mailbox and who sees it; owners and admins add one and change
//   who sees it (ADR 0008).
// - Members' inboxes (owners and admins): each teammate's personal inbox, whether it exists and
//   syncs. Never its mail: nothing here opens it or gives anyone access (ADR 0017).
import { UserMinusIcon } from "@heroicons/react/24/outline";
import { lazy, useState } from "react";
import { Skeleton, SkeletonSuspense } from "skullet/react";
import { Badge } from "@/components/ui/badge";
import type { ChartConfig } from "@/components/ui/chart";
import { Label } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useCounts, useMailboxes } from "@/hooks/use-mail.ts";
import {
  useAddMailboxMember,
  useMailboxMembers,
  useRemoveMailboxMember,
  useWorkspaceMailboxes,
} from "@/hooks/use-mailbox-members.ts";
import { useCreateMailboxes, useOnboarding } from "@/hooks/use-onboarding.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import { parseServer } from "@/lib/onboarding.ts";
import {
  LANES,
  type Lane,
  type Mailbox,
  type OnboardingDomain,
  type OrgMailbox,
} from "@/lib/types.ts";
import { PersonAvatar } from "./account-pages";
import { SettingsAddRow } from "./kit/settings-add-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsLinkRow } from "./kit/settings-link-row";
import { SettingsMeterRow } from "./kit/settings-meter-row";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import {
  SettingsConfirmDialog,
  SettingsFormDialog,
  SettingsListDialog,
} from "./kit/settings-stacked-dialog";
import { SettingsValueRow } from "./kit/settings-value-row";
import { isManager } from "./workspace-pages";

// The chart library is most of a megabyte: it loads when a chart is first drawn, not with the app.
const SettingsChart = lazy(() =>
  import("./kit/settings-chart").then((module) => ({ default: module.SettingsChart })),
);

// The sidebar's names for the lanes, plus the rest.
const LANE_LABELS: Record<Lane, string> = {
  needs_reply: "Needs reply",
  waiting_on_them: "Awaiting reply",
  fyi: "FYI",
  noise: "Noise",
  unsure: "Unsure",
};

const LANE_CHART: ChartConfig = Object.fromEntries(
  LANES.map((lane, i) => [lane, { label: LANE_LABELS[lane], color: `chart-${i + 1}` }]),
);

/** What a mailbox is called in a list: its local part, capitalised. */
function mailboxName(mailbox: { address: string }) {
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** A mailbox that isn't syncing normally, in words; null while it is. */
const MAILBOX_STATUS: Record<
  Mailbox["status"],
  { label: string; intent: "secondary" | "danger" } | null
> = {
  active: null,
  pending: { label: "Connecting", intent: "secondary" },
  error: { label: "Not syncing", intent: "danger" },
  disabled: { label: "Turned off", intent: "secondary" },
};

function MailboxStatusBadge({ mailbox }: { mailbox: Pick<Mailbox, "status"> }) {
  const status = MAILBOX_STATUS[mailbox.status];
  return status ? <Badge intent={status.intent}>{status.label}</Badge> : null;
}

const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "Synced 4 minutes ago", from the latest folder sync. */
function syncedLabel(at: string | null) {
  if (!at) return "Not synced yet";
  const minutes = Math.round((Date.parse(at) - Date.now()) / 60_000);
  if (minutes > -1) return "Synced just now";
  if (minutes > -60) return `Synced ${RELATIVE.format(minutes, "minute")}`;
  if (minutes > -60 * 24) return `Synced ${RELATIVE.format(Math.round(minutes / 60), "hour")}`;
  return `Synced ${RELATIVE.format(Math.round(minutes / 1440), "day")}`;
}

// Skeleton stand-ins, the shape of what loads, drawn before the first load.
type AccessList = NonNullable<ReturnType<typeof useMailboxMembers>["data"]>["members"];
type MemberList = NonNullable<ReturnType<typeof useMembers>["data"]>["members"];
const SAMPLE_ADDRESSES = ["you@example.com", "hello@example.com", "billing@example.com"];
const SAMPLE_MAILBOXES = SAMPLE_ADDRESSES.map((address, i) => ({
  id: `sample-${i}`,
  orgId: "sample",
  address,
  kind: i === 0 ? "personal" : "shared",
  provider: "purelymail",
  status: "active",
  role: "member",
})) as Mailbox[];
const SAMPLE_ORG_MAILBOXES = SAMPLE_ADDRESSES.map((address, i) => ({
  id: `sample-${i}`,
  address,
  kind: "shared",
  provider: "purelymail",
  status: "active",
  createdAt: "",
  syncedAt: null,
  people: 2,
  owner: null,
})) as OrgMailbox[];
const SAMPLE_PEOPLE = ["Sample person", "Another person", "Third person"].map((name, i) => ({
  id: `sample-${i}`,
  name,
  email: `person${i}@example.com`,
}));
const SAMPLE_ACCESS = SAMPLE_PEOPLE.map((p) => ({
  memberId: p.id,
  name: p.name,
  email: p.email,
  image: null,
})) as unknown as AccessList;
const SAMPLE_MEMBERS = SAMPLE_PEOPLE.map((p) => ({
  id: p.id,
  role: "member",
  user: { name: p.name, email: p.email, image: null },
})) as unknown as MemberList;

/** The mailboxes the signed-in member can open in the active workspace. */
function useOwnMailboxes() {
  const { member } = useMember();
  const mailboxes = useMailboxes();
  return mailboxes.data?.filter((mailbox) => mailbox.orgId === member.orgId);
}

/** Domains a new mailbox can go on: verified here, and accepted by the provider. */
function useMailboxDomains() {
  const onboarding = useOnboarding();
  return onboarding.data?.domains.filter(
    (domain) => domain.status === "verified" && (domain.provider === "imap" || domain.added),
  );
}

export function YourMailboxesPage() {
  const mine = useOwnMailboxes();
  const counts = useCounts();
  // Each mailbox with something in its inbox, beside its counts; undefined until both load.
  const busy =
    mine && counts.data
      ? mine.flatMap((mailbox) => {
          const row = counts.data.counts.find((count) => count.mailboxId === mailbox.id);
          return row && row.inbox > 0 ? [{ mailbox, row }] : [];
        })
      : undefined;

  return (
    <SettingsSections>
      <SettingsSection title="Mailboxes">
        <Skeleton
          id="settings-mailboxes"
          data={mine}
          sample={SAMPLE_MAILBOXES}
          label="Loading mailboxes"
        >
          {(list) => (
            <SettingsGroup>
              {list.length === 0 ? (
                <SettingsEmptyState
                  title="No mailboxes"
                  description="An owner or admin can create your inbox or add you to a shared one."
                />
              ) : (
                list.map((mailbox) => <OwnMailboxRow key={mailbox.id} mailbox={mailbox} />)
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <SettingsSection
        title="Inbox by lane"
        info="Threads in each inbox now, by the lane triage put them in."
      >
        <Skeleton id="settings-inbox" data={busy} sample={[]} label="Loading counts">
          {(list) => (
            <SettingsGroup>
              {list.length === 0 ? (
                <SettingsEmptyState
                  title="Inbox zero"
                  description="Nothing waits in any inbox right now."
                />
              ) : (
                <SkeletonSuspense skeleton={<div className="h-62" />}>
                  <SettingsChart
                    config={LANE_CHART}
                    dataKey="mailbox"
                    data={list.map(({ mailbox, row }) => ({
                      mailbox: mailboxName(mailbox),
                      ...row.lanes,
                    }))}
                  />
                </SkeletonSuspense>
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      {/* Only when there is an inbox to read: an empty one is said once, above. */}
      {busy && busy.length > 0 && (
        <SettingsSection title="Unread">
          <SettingsGroup>
            {busy.map(({ mailbox, row }) => (
              <SettingsMeterRow
                key={mailbox.id}
                label={mailboxName(mailbox)}
                amount={`${row.unread} of ${row.inbox}`}
                value={row.unread}
                max={row.inbox}
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}
    </SettingsSections>
  );
}

/** A mailbox you can open: who else sees it, as a fact. Changing that is on Shared mailboxes. */
function OwnMailboxRow({ mailbox }: { mailbox: Mailbox }) {
  const shared = mailbox.kind === "shared";
  const count = useMailboxMembers(mailbox.id, shared).data?.members.length;
  return (
    <SettingsValueRow
      label={mailboxName(mailbox)}
      badge={<MailboxStatusBadge mailbox={mailbox} />}
      description={mailbox.address}
      value={shared ? (count === undefined ? "" : people(count)) : "Only you"}
      tone="muted"
    />
  );
}

/** One shared mailbox as this page lists it, from whichever list the viewer may read. */
interface SharedRow {
  id: string;
  address: string;
  status: Mailbox["status"];
  /** Known up front for managers (the workspace list); members count it per row. */
  people?: number;
}

export function SharedMailboxesPage() {
  const { member } = useMember();
  const canManage = isManager(member.role);
  const all = useWorkspaceMailboxes(canManage);
  const mine = useOwnMailboxes();
  const domains = useMailboxDomains();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Owners and admins see every shared mailbox; members, the ones they are on.
  const shared: SharedRow[] | undefined = canManage
    ? all.data?.mailboxes.filter((mailbox) => mailbox.kind === "shared")
    : mine?.filter((mailbox) => mailbox.kind === "shared");
  const open = shared?.find((mailbox) => mailbox.id === openId);
  const canAdd = canManage && !!domains && domains.length > 0;

  return (
    <SettingsSections>
      <SettingsSection
        title="Access"
        info="Each is seen by the people on it; read state stays per person."
      >
        <Skeleton
          id="settings-shared-mailboxes"
          data={shared}
          sample={SAMPLE_ORG_MAILBOXES}
          label="Loading shared mailboxes"
        >
          {(list) => (
            <SettingsGroup>
              {canAdd && (
                <SettingsAddRow label="Add a shared mailbox" onPress={() => setAdding(true)} />
              )}
              {list.length === 0 && (
                <SettingsEmptyState
                  title="No shared mailboxes"
                  description={
                    canManage
                      ? "For an address several people answer, like hello@."
                      : "An owner or admin can add you to one."
                  }
                />
              )}
              {list.map((mailbox) => (
                <SharedMailboxRow
                  key={mailbox.id}
                  mailbox={mailbox}
                  onOpen={() => setOpenId(mailbox.id)}
                />
              ))}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
      {open && (
        <MailboxAccessDialog mailbox={open} canManage={canManage} onClose={() => setOpenId(null)} />
      )}
      {adding && domains && (
        <NewMailboxDialog kind="shared" domains={domains} onClose={() => setAdding(false)} />
      )}
    </SettingsSections>
  );
}

/** A shared mailbox: who can see it, as a count. The whole row opens that list over settings. */
function SharedMailboxRow({ mailbox, onOpen }: { mailbox: SharedRow; onOpen: () => void }) {
  const counted = useMailboxMembers(mailbox.id, mailbox.people === undefined);
  const count = mailbox.people ?? counted.data?.members.length;
  return (
    <SettingsLinkRow
      label={mailboxName(mailbox)}
      badge={<MailboxStatusBadge mailbox={mailbox} />}
      description={mailbox.address}
      value={count !== undefined && <span className="tabular-nums">{people(count)}</span>}
      onPress={onOpen}
    />
  );
}

/** What a stacked dialog over the access list is doing, if anything. */
type AccessDialog = { kind: "add" } | { kind: "remove"; memberId: string; name: string };

function MailboxAccessDialog(props: {
  mailbox: SharedRow;
  canManage: boolean;
  onClose: () => void;
}) {
  const { mailbox, canManage } = props;
  const access = useMailboxMembers(mailbox.id);
  const members = useMembers();
  const remove = useRemoveMailboxMember();
  const [dialog, setDialog] = useState<AccessDialog | null>(null);
  const close = () => setDialog(null);
  const granted = new Set(access.data?.members.map((person) => person.memberId));
  const addable = (members.data?.members ?? [])
    .filter((person) => !granted.has(person.id))
    .map((person) => ({ id: person.id, name: person.user.name || person.user.email }));

  return (
    <SettingsListDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={`Who can see ${mailboxName(mailbox)}`}
      description={mailbox.address}
    >
      <Skeleton
        id={`settings-access-${mailbox.id}`}
        data={access.data?.members}
        sample={SAMPLE_ACCESS}
        label="Loading access"
      >
        {(list) => (
          <SettingsGroup>
            {canManage && addable.length > 0 && (
              <SettingsAddRow label="Add a person" onPress={() => setDialog({ kind: "add" })} />
            )}
            {list.length === 0 && (
              <SettingsEmptyState title="Nobody yet" description="Add the people who answer it." />
            )}
            {list.map((person) => {
              const name = person.name || person.email;
              return (
                <SettingsRow
                  key={person.memberId}
                  avatar={<PersonAvatar name={name} image={person.image} />}
                  label={name}
                  description={person.name ? person.email : undefined}
                  control={
                    canManage && (
                      <SettingsRowMenu
                        label={`Actions for ${name}`}
                        items={[
                          {
                            icon: UserMinusIcon,
                            label: "Remove access",
                            danger: true,
                            onAction: () =>
                              setDialog({ kind: "remove", memberId: person.memberId, name }),
                          },
                        ]}
                      />
                    )
                  }
                />
              );
            })}
          </SettingsGroup>
        )}
      </Skeleton>
      {dialog?.kind === "add" && (
        <AddAccessDialog mailbox={mailbox} people={addable} onClose={close} />
      )}
      <SettingsConfirmDialog
        isOpen={dialog?.kind === "remove"}
        onOpenChange={(open) => !open && close()}
        title="Remove access?"
        description={`${dialog?.kind === "remove" ? dialog.name : "They"} will no longer see ${mailbox.address} or its threads.`}
        action="Remove"
        saving={remove.isPending}
        onConfirm={() =>
          dialog?.kind === "remove" &&
          remove.mutate(
            { mailboxId: mailbox.id, memberId: dialog.memberId },
            {
              onSuccess: close,
              onError: () => appToast.error(`Access for ${dialog.name} could not be removed.`),
            },
          )
        }
      />
    </SettingsListDialog>
  );
}

function AddAccessDialog(props: {
  mailbox: SharedRow;
  people: { id: string; name: string }[];
  onClose: () => void;
}) {
  const add = useAddMailboxMember();
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={`Add to ${mailboxName(props.mailbox)}`}
      description="They see its threads in their inbox from now on."
      action="Add"
      disabled={!picked}
      saving={add.isPending}
      onSubmit={() =>
        picked &&
        add.mutate(
          { mailboxId: props.mailbox.id, memberId: picked },
          {
            onSuccess: props.onClose,
            onError: () => appToast.error("Access could not be given."),
          },
        )
      }
    >
      <PersonSelect people={props.people} value={picked} onChange={setPicked} />
    </SettingsFormDialog>
  );
}

function PersonSelect(props: {
  people: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select
      placeholder="Choose a person"
      value={props.value}
      onChange={(next) => props.onChange(next === null ? null : String(next))}
    >
      <Label>Person</Label>
      <SelectTrigger />
      <SelectContent items={props.people}>
        {(person) => (
          <SelectItem id={person.id} textValue={person.name}>
            {person.name}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

export function MembersInboxesPage() {
  const members = useMembers();
  const all = useWorkspaceMailboxes();
  const domains = useMailboxDomains();
  const { member: me } = useMember();
  const [creating, setCreating] = useState(false);
  const personal = all.data?.mailboxes.filter((mailbox) => mailbox.kind === "personal");
  // Each member with their personal inboxes, in the People page's order; then any inbox whose
  // owner has left. Undefined until both lists load.
  const rows =
    members.data && personal
      ? {
          people: members.data.members.map((person) => ({
            person,
            inboxes: personal.filter((mailbox) => mailbox.owner?.memberId === person.id),
          })),
          orphans: personal.filter((mailbox) => !mailbox.owner),
        }
      : undefined;
  const without = rows?.people.filter((row) => row.inboxes.length === 0) ?? [];
  const canCreate = !!domains && domains.length > 0 && without.length > 0;

  return (
    <SettingsSections>
      <SettingsSection
        title="Personal inboxes"
        info="You see that each inbox exists and whether it syncs, never its mail."
      >
        <Skeleton
          id="settings-members-inboxes"
          data={rows}
          sample={{
            people: SAMPLE_MEMBERS.map((person) => ({ person, inboxes: [] })),
            orphans: [],
          }}
          label="Loading inboxes"
        >
          {({ people: list, orphans }) => (
            <SettingsGroup>
              {canCreate && (
                <SettingsAddRow label="Create an inbox" onPress={() => setCreating(true)} />
              )}
              {list.flatMap(({ person, inboxes }) => {
                const name = person.user.name || person.user.email;
                const avatar = <PersonAvatar name={name} image={person.user.image} />;
                const hint = person.id === me.id ? "you" : undefined;
                if (inboxes.length === 0) {
                  return [
                    <SettingsValueRow
                      key={person.id}
                      avatar={avatar}
                      label={name}
                      hint={hint}
                      description={person.user.email}
                      value="No inbox"
                      tone="muted"
                    />,
                  ];
                }
                // Its health is the value: a badge would make the row taller than its peers.
                return inboxes.map((inbox) => (
                  <SettingsValueRow
                    key={inbox.id}
                    avatar={avatar}
                    label={name}
                    hint={hint}
                    description={inbox.address}
                    value={MAILBOX_STATUS[inbox.status]?.label ?? syncedLabel(inbox.syncedAt)}
                    tone={inbox.status === "error" ? "danger" : "muted"}
                  />
                ));
              })}
              {orphans.map((inbox) => (
                <SettingsValueRow
                  key={inbox.id}
                  label={mailboxName(inbox)}
                  description={inbox.address}
                  value="No owner"
                  tone="muted"
                />
              ))}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
      {creating && domains && (
        <NewMailboxDialog
          kind="personal"
          domains={domains}
          people={without.map(({ person }) => ({
            id: person.id,
            name: person.user.name || person.user.email,
            email: person.user.email,
          }))}
          onClose={() => setCreating(false)}
        />
      )}
    </SettingsSections>
  );
}

/** The local part people get by default: theirs, as they sign in. */
const localPartOf = (email: string) => email.split("@")[0] ?? "";

/**
 * Creates a mailbox on one of the workspace's domains (the setup route, ADR 0017): a shared one,
 * or a teammate's personal inbox that only they will see. On the workspace's own mail host it
 * needs the mailbox's existing password and servers, as in setup.
 */
function NewMailboxDialog(props: {
  kind: "shared" | "personal";
  domains: OnboardingDomain[];
  people?: { id: string; name: string; email: string }[];
  onClose: () => void;
}) {
  const create = useCreateMailboxes();
  const [domainId, setDomainId] = useState(props.domains[0]!.id);
  const [personId, setPersonId] = useState<string | null>(null);
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState("");
  const [smtp, setSmtp] = useState("");
  const domain = props.domains.find((d) => d.id === domainId) ?? props.domains[0]!;
  const ownHost = domain.provider === "imap";
  const person = props.people?.find((p) => p.id === personId);
  const servers = ownHost ? { imap: parseServer(imap, 993), smtp: parseServer(smtp, 465) } : null;
  const ready =
    localPart.trim() !== "" &&
    (props.kind === "shared" || !!person) &&
    (!servers || (!!password && !!servers.imap && !!servers.smtp));

  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={props.kind === "shared" ? "Add a shared mailbox" : "Create an inbox"}
      description={
        props.kind === "shared"
          ? "You can choose who sees it next."
          : "Only they will see it. You won't."
      }
      action={props.kind === "shared" ? "Add" : "Create"}
      disabled={!ready}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            domainId: domain.id,
            mailboxes: [
              {
                localPart: localPart.trim(),
                ...(ownHost ? { password } : {}),
                ...(person ? { forMemberId: person.id } : {}),
              },
            ],
            ...(servers?.imap && servers.smtp
              ? { servers: { imap: servers.imap, smtp: servers.smtp } }
              : {}),
          },
          {
            onSuccess: ([made]) => {
              props.onClose();
              appToast.success(
                person ? `Created ${made?.address} for ${person.name}` : `Added ${made?.address}`,
              );
            },
            onError: (error) => appToast.error(error.message || "The mailbox was not created."),
          },
        )
      }
    >
      {props.people && (
        <PersonSelect
          people={props.people}
          value={personId}
          onChange={(id) => {
            setPersonId(id);
            // Their sign-in name is the likely address; typed one stays.
            const next = props.people?.find((p) => p.id === id);
            if (next && !localPart) setLocalPart(localPartOf(next.email));
          }}
        />
      )}
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
      <TextField isRequired autoFocus={!props.people} value={localPart} onChange={setLocalPart}>
        <Label>Address</Label>
        <InputGroup className="[--input-gutter-end:--spacing(4)]">
          <Input placeholder={props.kind === "shared" ? "hello" : "name"} autoComplete="off" />
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
