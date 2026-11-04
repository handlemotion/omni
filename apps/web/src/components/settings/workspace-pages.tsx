// Settings pages about the active workspace: what it is and the others you belong to, who is in
// it, and who can see each mailbox.
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { cn } from "cn";
import { type CSSProperties, lazy, useState } from "react";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { Skeleton, SkeletonSuspense } from "skullet/react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChartConfig } from "@/components/ui/chart";
import { CopyField } from "@/components/ui/copy-field";
import { appToast } from "@/components/ui/toast";
import { useCounts, useMailboxes } from "@/hooks/use-mail.ts";
import { useCheckDomain, useOnboarding } from "@/hooks/use-onboarding.ts";
import {
  useAddMailboxMember,
  useMailboxMembers,
  useRemoveMailboxMember,
} from "@/hooks/use-mailbox-members.ts";
import {
  useCancelInvitation,
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useRenameWorkspace,
  useResendInvitation,
  useUpdateMemberRole,
} from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import {
  LANES,
  type DnsRecord,
  type Lane,
  type Mailbox,
  type OnboardingDomain,
  type Workspace,
} from "@/lib/types.ts";
import { EditableValue, PersonAvatar } from "./account-pages";
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
  SettingsRenameDialog,
} from "./kit/settings-stacked-dialog";
import { SettingsValueRow } from "./kit/settings-value-row";

// The chart library is most of a megabyte: it loads when a chart is first drawn, not with the app.
const SettingsChart = lazy(() =>
  import("./kit/settings-chart").then((module) => ({ default: module.SettingsChart })),
);

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** The role a member holds, as people say it. Better Auth stores several as a comma list. */
function roleLabel(role: string) {
  const first = role.split(",")[0]?.trim() ?? role;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Skeleton stand-ins: the shape of what loads (three people), drawn before the first load.
type MemberList = NonNullable<ReturnType<typeof useMembers>["data"]>["members"];
type AccessList = NonNullable<ReturnType<typeof useMailboxMembers>["data"]>["members"];
const SAMPLE_PEOPLE = ["Sample person", "Another person", "Third person"].map((name, i) => ({
  id: `sample-${i}`,
  name,
  email: `person${i}@example.com`,
}));
const SAMPLE_MEMBERS = SAMPLE_PEOPLE.map((p) => ({
  id: p.id,
  role: "member",
  user: { name: p.name, email: p.email, image: null },
})) as unknown as MemberList;
const SAMPLE_ACCESS = SAMPLE_PEOPLE.map((p) => ({
  memberId: p.id,
  name: p.name,
  email: p.email,
  image: null,
})) as unknown as AccessList;

const isManager = (role: string) => /\b(owner|admin)\b/.test(role);

/** The active workspace's square mark at `size` px: its logo, or its initial. */
export function WorkspaceAvatar({ workspace, size }: { workspace: Workspace; size: number }) {
  return (
    <Avatar
      isSquare
      src={workspace.logo}
      initials={size >= 20 ? workspace.name.slice(0, 1).toUpperCase() : undefined}
      // A plain nav-sized mark is `muted`, so it still reads on the current row's accent fill.
      className={cn("text-foreground outline-0", size >= 20 ? "bg-accent" : "bg-muted")}
      style={{ "--avatar-size": `${size}px` } as CSSProperties}
    />
  );
}

export function GeneralPage() {
  const { member } = useMember();
  const workspaces = useWorkspaces();
  const rename = useRenameWorkspace();
  const [renaming, setRenaming] = useState(false);
  const canManage = isManager(member.role);
  const active = workspaces.data?.workspaces.find((workspace) => workspace.id === member.orgId);

  return (
    <SettingsSections>
      <SettingsSection title="Workspace">
        <Skeleton id="settings-workspace" data={active} label="Loading workspace">
          {(workspace) => (
            <SettingsGroup>
              {canManage ? (
                <SettingsRow
                  label="Name"
                  control={
                    <EditableValue
                      value={workspace.name}
                      label="Edit workspace name"
                      onEdit={() => setRenaming(true)}
                    />
                  }
                />
              ) : (
                <SettingsValueRow label="Name" value={workspace.name} />
              )}
              <SettingsValueRow label="Handle" value={workspace.slug} mono />
              <SettingsValueRow label="Your role" value={roleLabel(member.role)} />
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      {canManage && <DomainsSection />}

      {renaming && active && (
        <SettingsRenameDialog
          title="Edit workspace name"
          description="Everyone in the workspace sees it in the switcher and on invitations."
          label="Name"
          name={active.name}
          saving={rename.isPending}
          onClose={() => setRenaming(false)}
          onSave={(name) =>
            rename.mutate(name, {
              onSuccess: () => setRenaming(false),
              onError: () => appToast.error("The workspace could not be renamed."),
            })
          }
        />
      )}
    </SettingsSections>
  );
}

/** What each record is for, in the order setup asks for them (onboarding's names). */
const RECORD_PURPOSES: Record<DnsRecord["check"], string> = {
  ownership: "Proves you own it",
  mx: "Receives mail",
  spf: "Allows sending",
  dkim: "Signs outgoing mail",
  dmarc: "Sets a policy",
};

/** The record's type, and the standard it implements where that's a name people look up. */
function recordKind(record: DnsRecord) {
  return record.check === "spf" || record.check === "dkim" || record.check === "dmarc"
    ? `${record.check.toUpperCase()}, ${record.type}`
    : record.type;
}

/** Passing: the provider saw it, or the domain's own nameservers already serve it. */
const recordPasses = (record: DnsRecord) => record.verified || record.diagnostic?.status === "ok";

/** A domain's state in one word, and the badge colour it reads in. */
function domainState(domain: OnboardingDomain) {
  if (domain.status === "expired") return { label: "Expired", intent: "danger" } as const;
  if (domain.status === "pending") return { label: "Pending", intent: "secondary" } as const;
  if (domain.challenge && !domain.challenge.verified)
    return { label: "Ownership lost", intent: "danger" } as const;
  if (!domain.records.every(recordPasses))
    return { label: "Needs attention", intent: "warning" } as const;
  return { label: "Verified", intent: "success" } as const;
}

/**
 * The workspace's mail domains (owners and admins: only they can see or change them). Each opens
 * its DNS records over settings, to copy again or check after a change at the DNS host.
 */
function DomainsSection() {
  const onboarding = useOnboarding();
  const [openId, setOpenId] = useState<string | null>(null);
  const domains = onboarding.data?.domains;
  const open = domains?.find((domain) => domain.id === openId);
  if (domains && domains.length === 0) return null;

  return (
    <SettingsSection title="Domains">
      <Skeleton id="settings-domains" data={domains} sample={[]} label="Loading domains">
        {(list) => (
          <SettingsGroup>
            {list.map((domain) => {
              const state = domainState(domain);
              const description =
                domain.provider === "purelymail" ? "Hosted by Purelymail" : "Your own mail host";
              const badge = <Badge intent={state.intent}>{state.label}</Badge>;
              return domain.records.length > 0 ? (
                <SettingsLinkRow
                  key={domain.id}
                  icon={GlobeAltIcon}
                  label={domain.domain}
                  description={description}
                  value={badge}
                  onPress={() => setOpenId(domain.id)}
                />
              ) : (
                <SettingsRow
                  key={domain.id}
                  icon={GlobeAltIcon}
                  label={domain.domain}
                  description={description}
                  className="pe-4"
                  control={badge}
                />
              );
            })}
          </SettingsGroup>
        )}
      </Skeleton>
      {open && <DomainRecordsDialog domain={open} onClose={() => setOpenId(null)} />}
    </SettingsSection>
  );
}

function DomainRecordsDialog(props: { domain: OnboardingDomain; onClose: () => void }) {
  const { domain } = props;
  const check = useCheckDomain();
  return (
    <SettingsListDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={domain.domain}
      description="The records at your DNS host. Each must stay in place for mail to flow."
      footer={
        <Button
          intent="outline"
          isPending={check.isPending}
          onPress={() =>
            check.mutate(domain.id, {
              onError: (error) => appToast.error(error.message || "The records were not checked."),
            })
          }
        >
          Check records
        </Button>
      }
    >
      <SettingsGroup>
        {domain.records.map((record) => {
          const passes = recordPasses(record);
          return (
            // A record: what it's for and whether it passes, then its two values to copy.
            <div key={`${record.type} ${record.name}`} className="flex flex-col gap-3 px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm/4 text-foreground">
                  {RECORD_PURPOSES[record.check]}
                  <span className="text-muted-foreground"> ({recordKind(record)})</span>
                </span>
                <Badge intent={passes ? "success" : "warning"}>
                  {passes ? "Found" : "Not found"}
                </Badge>
              </div>
              <div className="flex flex-col gap-2 [--copy-label-width:--spacing(13)]">
                <CopyField label="Host" value={record.name} />
                <CopyField
                  label="Value"
                  value={
                    record.diagnostic?.suggestion ??
                    (record.priority !== undefined
                      ? `${record.priority} ${record.value}`
                      : record.value)
                  }
                />
              </div>
            </div>
          );
        })}
      </SettingsGroup>
    </SettingsListDialog>
  );
}

type Role = "member" | "admin";

const ROLE_OPTIONS: { label: string; value: Role }[] = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

/** A member's role as a quiet badge, the way transitive lists people. */
function RoleBadge({ role }: { role: string }) {
  return <Badge intent="secondary">{roleLabel(role)}</Badge>;
}

/** What a stacked dialog over the People page is doing, if anything. */
type PeopleDialog =
  | { kind: "invite" }
  | { kind: "role"; memberId: string; name: string; role: Role }
  | { kind: "remove"; memberId: string; name: string }
  | { kind: "revoke"; invitationId: string; email: string };

export function PeoplePage() {
  const { member: me } = useMember();
  const members = useMembers();
  const invitations = useInvitations();
  const remove = useRemoveMember();
  const cancel = useCancelInvitation();
  const resend = useResendInvitation();
  const canManage = isManager(me.role);
  const pending = invitations.data?.filter((invitation) => invitation.status === "pending");
  const [dialog, setDialog] = useState<PeopleDialog | null>(null);
  const close = () => setDialog(null);

  return (
    <SettingsSections>
      <SettingsSection title="Members">
        <Skeleton
          id="settings-members"
          data={members.data?.members}
          sample={SAMPLE_MEMBERS}
          label="Loading members"
        >
          {(list) => (
            <SettingsGroup>
              {canManage && (
                <SettingsAddRow
                  label="Invite member"
                  onPress={() => setDialog({ kind: "invite" })}
                />
              )}
              {list.map((person) => {
                const name = person.user.name || person.user.email;
                const self = person.id === me.id;
                const editable = canManage && !self && !person.role.includes("owner");
                return (
                  <SettingsRow
                    key={person.id}
                    avatar={<PersonAvatar name={name} image={person.user.image} />}
                    label={name}
                    hint={self ? "you" : undefined}
                    description={person.user.name ? person.user.email : undefined}
                    control={
                      <>
                        <RoleBadge role={person.role} />
                        {editable && (
                          <SettingsRowMenu
                            label={`Actions for ${name}`}
                            items={[
                              {
                                label: "Change role",
                                onAction: () =>
                                  setDialog({
                                    kind: "role",
                                    memberId: person.id,
                                    name,
                                    role: person.role.includes("admin") ? "admin" : "member",
                                  }),
                              },
                              {
                                label: "Remove from workspace",
                                danger: true,
                                onAction: () =>
                                  setDialog({ kind: "remove", memberId: person.id, name }),
                              },
                            ]}
                          />
                        )}
                      </>
                    }
                  />
                );
              })}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <SettingsSection title="Invited">
        <Skeleton id="settings-invitations" data={pending} sample={[]} label="Loading invitations">
          {(list) => (
            <SettingsGroup>
              {list.length === 0 ? (
                <SettingsEmptyState
                  title="No pending invitations"
                  description="People you invite appear here until they join."
                />
              ) : (
                list.map((invitation) => (
                  <SettingsRow
                    key={invitation.id}
                    label={invitation.email}
                    description={`Expires ${DAY.format(new Date(invitation.expiresAt))}`}
                    control={
                      <>
                        <RoleBadge role={invitation.role ?? "member"} />
                        {canManage && (
                          <SettingsRowMenu
                            label={`Actions for ${invitation.email}`}
                            items={[
                              {
                                label: "Resend invitation",
                                onAction: () => {
                                  const role = invitation.role === "admin" ? "admin" : "member";
                                  resend.mutate(
                                    { email: invitation.email, role },
                                    {
                                      onSuccess: () =>
                                        appToast.success(
                                          `Invitation sent again to ${invitation.email}`,
                                        ),
                                      onError: (error) =>
                                        appToast.error(
                                          error.message || "The invitation was not sent again.",
                                        ),
                                    },
                                  );
                                },
                              },
                              {
                                label: "Revoke invitation",
                                danger: true,
                                onAction: () =>
                                  setDialog({
                                    kind: "revoke",
                                    invitationId: invitation.id,
                                    email: invitation.email,
                                  }),
                              },
                            ]}
                          />
                        )}
                      </>
                    }
                  />
                ))
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <InviteDialog isOpen={dialog?.kind === "invite"} onClose={close} />
      {dialog?.kind === "role" && <RoleDialog key={dialog.memberId} {...dialog} onClose={close} />}
      <SettingsConfirmDialog
        isOpen={dialog?.kind === "remove"}
        onOpenChange={(open) => !open && close()}
        title="Remove from workspace?"
        description={`${dialog?.kind === "remove" ? dialog.name : "They"} loses access to this workspace and its mailboxes.`}
        action="Remove"
        saving={remove.isPending}
        onConfirm={() =>
          dialog?.kind === "remove" &&
          remove.mutate(dialog.memberId, {
            onSuccess: close,
            onError: () => appToast.error(`${dialog.name} could not be removed.`),
          })
        }
      />
      <SettingsConfirmDialog
        isOpen={dialog?.kind === "revoke"}
        onOpenChange={(open) => !open && close()}
        title="Revoke invitation?"
        description={`${dialog?.kind === "revoke" ? dialog.email : "This person"} can no longer join with this invitation.`}
        action="Revoke"
        saving={cancel.isPending}
        onConfirm={() =>
          dialog?.kind === "revoke" &&
          cancel.mutate(dialog.invitationId, {
            onSuccess: close,
            onError: () => appToast.error("The invitation could not be revoked."),
          })
        }
      />
    </SettingsSections>
  );
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <Select
      value={value}
      onChange={(next) => {
        const option = ROLE_OPTIONS.find((role) => role.value === next);
        if (option) onChange(option.value);
      }}
    >
      <Label>Role</Label>
      <SelectTrigger />
      <SelectContent items={ROLE_OPTIONS}>
        {(role) => (
          <SelectItem id={role.value} textValue={role.label}>
            {role.label}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function InviteDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const invite = useInviteMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const address = email.trim();
  return (
    <SettingsFormDialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      title="Invite member"
      description="They get an email with a link to join this workspace."
      action="Invite"
      disabled={!address}
      saving={invite.isPending}
      onSubmit={() =>
        invite.mutate(
          { email: address, role },
          {
            onSuccess: () => {
              setEmail("");
              setRole("member");
              onClose();
              appToast.success(`Invitation sent to ${address}`);
            },
            onError: (error) => appToast.error(error.message || "The invitation was not sent."),
          },
        )
      }
    >
      <TextField type="email" isRequired autoFocus value={email} onChange={setEmail}>
        <Label>Email</Label>
        <Input placeholder="name@company.com" autoComplete="off" />
      </TextField>
      <RoleSelect value={role} onChange={setRole} />
    </SettingsFormDialog>
  );
}

function RoleDialog(props: { memberId: string; name: string; role: Role; onClose: () => void }) {
  const update = useUpdateMemberRole();
  const [role, setRole] = useState<Role>(props.role);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Change role"
      description={`Admins can invite people and decide who sees each mailbox. ${props.name} is a ${roleLabel(props.role).toLowerCase()} now.`}
      action="Save"
      disabled={role === props.role}
      saving={update.isPending}
      onSubmit={() =>
        update.mutate(
          { memberId: props.memberId, role },
          {
            onSuccess: props.onClose,
            onError: () => appToast.error("The role could not be changed."),
          },
        )
      }
    >
      <RoleSelect value={role} onChange={setRole} />
    </SettingsFormDialog>
  );
}

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
function mailboxName(mailbox: Pick<Mailbox, "address">) {
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

function MailboxStatusBadge({ mailbox }: { mailbox: Mailbox }) {
  const status = MAILBOX_STATUS[mailbox.status];
  return status ? <Badge intent={status.intent}>{status.label}</Badge> : null;
}

export function MailboxesPage() {
  const { member } = useMember();
  const mailboxes = useMailboxes();
  const counts = useCounts();
  const canManage = isManager(member.role);
  const mine = mailboxes.data?.filter((mailbox) => mailbox.orgId === member.orgId);
  // Each mailbox with something in its inbox, beside its counts; undefined until both load.
  const busy =
    mine && counts.data
      ? mine.flatMap((mailbox) => {
          const row = counts.data.counts.find((count) => count.mailboxId === mailbox.id);
          return row && row.inbox > 0 ? [{ mailbox, row }] : [];
        })
      : undefined;
  const [openId, setOpenId] = useState<string | null>(null);
  const open = mine?.find((mailbox) => mailbox.id === openId);

  return (
    <SettingsSections>
      <SettingsSection
        title="Access"
        info="Shared mailboxes are seen by the people you choose; a personal one only by its owner."
      >
        <Skeleton id="settings-mailboxes" data={mine} label="Loading mailboxes">
          {(list) => (
            <SettingsGroup>
              {list.map((mailbox) =>
                mailbox.kind === "shared" ? (
                  <SharedMailboxRow
                    key={mailbox.id}
                    mailbox={mailbox}
                    onOpen={() => setOpenId(mailbox.id)}
                  />
                ) : (
                  <SettingsValueRow
                    key={mailbox.id}
                    label={mailboxName(mailbox)}
                    badge={<MailboxStatusBadge mailbox={mailbox} />}
                    description={mailbox.address}
                    value="Only you"
                    tone="muted"
                  />
                ),
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

      {open && (
        <MailboxAccessDialog mailbox={open} canManage={canManage} onClose={() => setOpenId(null)} />
      )}
    </SettingsSections>
  );
}

/** A shared mailbox: who can see it, as a count. The whole row opens that list over settings. */
function SharedMailboxRow({ mailbox, onOpen }: { mailbox: Mailbox; onOpen: () => void }) {
  const count = useMailboxMembers(mailbox.id).data?.members.length;
  return (
    <SettingsLinkRow
      label={mailboxName(mailbox)}
      badge={<MailboxStatusBadge mailbox={mailbox} />}
      description={mailbox.address}
      value={
        count !== undefined && (
          <span className="tabular-nums">
            {count} {count === 1 ? "person" : "people"}
          </span>
        )
      }
      onPress={onOpen}
    />
  );
}

/** What a stacked dialog over the access list is doing, if anything. */
type AccessDialog = { kind: "add" } | { kind: "remove"; memberId: string; name: string };

function MailboxAccessDialog(props: { mailbox: Mailbox; canManage: boolean; onClose: () => void }) {
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
  mailbox: Mailbox;
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
      <Select
        placeholder="Choose a person"
        value={picked}
        onChange={(next) => setPicked(next === null ? null : String(next))}
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
    </SettingsFormDialog>
  );
}
