// Settings pages about the active workspace: what it is and the others you belong to, who is in
// it, and who can see each mailbox.
import { lazy, useState } from "react";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { Skeleton, SkeletonSuspense } from "skullet/react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChartConfig } from "@/components/ui/chart";
import { appToast } from "@/components/ui/toast";
import { useCounts, useMailboxes } from "@/hooks/use-mail.ts";
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
  useUpdateMemberRole,
} from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import { LANES, type Lane, type Mailbox } from "@/lib/types.ts";
import { PersonAvatar } from "./account-pages";
import { SettingsAddRow } from "./kit/settings-add-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsMeterRow } from "./kit/settings-meter-row";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import {
  SettingsConfirmDialog,
  SettingsFormDialog,
  SettingsListDialog,
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

export function GeneralPage() {
  const { member } = useMember();
  const workspaces = useWorkspaces();
  const openWorkspace = useOpenWorkspace();
  const all = workspaces.data?.workspaces;
  const active = all?.find((workspace) => workspace.id === member.orgId);

  return (
    <SettingsSections>
      <SettingsSection title="Workspace">
        <Skeleton id="settings-workspace" data={active} label="Loading workspace">
          {(workspace) => (
            <SettingsGroup>
              {
                <>
                  <SettingsValueRow label="Name" value={workspace.name} />
                  <SettingsValueRow label="Handle" value={workspace.slug} mono />
                  <SettingsValueRow label="Your role" value={roleLabel(member.role)} />
                </>
              }
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <SettingsSection title="Your workspaces">
        <Skeleton id="settings-workspaces" data={all} label="Loading workspaces">
          {(list) => (
            <SettingsGroup>
              {list.map((workspace) => {
                const current = workspace.id === member.orgId;
                const unfinished = workspace.setup !== "complete";
                const count = workspace.mailboxes.length;
                return (
                  <SettingsRow
                    key={workspace.id}
                    avatar={
                      <Avatar
                        isSquare
                        src={workspace.logo}
                        initials={workspace.name.slice(0, 1).toUpperCase()}
                        className="bg-accent text-foreground outline-0"
                      />
                    }
                    label={workspace.name}
                    description={`${count} ${count === 1 ? "mailbox" : "mailboxes"}`}
                    control={
                      current && !unfinished ? (
                        <Badge intent="secondary">Current</Badge>
                      ) : (
                        <Button
                          intent="outline"
                          isPending={
                            openWorkspace.isPending && openWorkspace.variables.id === workspace.id
                          }
                          onPress={() =>
                            openWorkspace.mutate(workspace, {
                              onError: () => appToast.error("The workspace could not be opened."),
                            })
                          }
                        >
                          {unfinished ? "Continue setup" : "Open"}
                        </Button>
                      )
                    }
                  />
                );
              })}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
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

  return (
    <SettingsSections>
      <SettingsSection title="Mailboxes">
        <Skeleton id="settings-mailboxes" data={mine} label="Loading mailboxes">
          {(list) => (
            <SettingsGroup>
              {list.map((mailbox) =>
                mailbox.kind === "shared" ? (
                  <SharedMailboxRow key={mailbox.id} mailbox={mailbox} canManage={canManage} />
                ) : (
                  <SettingsValueRow
                    key={mailbox.id}
                    label={mailboxName(mailbox)}
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
        title="Inbox"
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
                <>
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
                  {list.map(({ mailbox, row }) => (
                    <SettingsMeterRow
                      key={mailbox.id}
                      label={mailboxName(mailbox)}
                      amount={`${row.unread} of ${row.inbox} unread`}
                      value={row.unread}
                      max={row.inbox}
                    />
                  ))}
                </>
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
  );
}

/**
 * A shared mailbox: who can see it, as a count. Its menu opens the list over settings, where
 * owners and admins add and remove people.
 */
function SharedMailboxRow({ mailbox, canManage }: { mailbox: Mailbox; canManage: boolean }) {
  const access = useMailboxMembers(mailbox.id);
  const [open, setOpen] = useState(false);
  const count = access.data?.members.length;
  return (
    <>
      <SettingsRow
        label={mailboxName(mailbox)}
        description={mailbox.address}
        control={
          <>
            {count !== undefined && (
              <span className="text-sm/4 text-muted-foreground tabular-nums">
                {count} {count === 1 ? "person" : "people"}
              </span>
            )}
            <SettingsRowMenu
              label={`Actions for ${mailbox.address}`}
              items={[
                {
                  label: canManage ? "Manage access" : "See who has access",
                  onAction: () => setOpen(true),
                },
              ]}
            />
          </>
        }
      />
      {open && (
        <MailboxAccessDialog
          mailbox={mailbox}
          canManage={canManage}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function MailboxAccessDialog(props: { mailbox: Mailbox; canManage: boolean; onClose: () => void }) {
  const { mailbox, canManage } = props;
  const access = useMailboxMembers(mailbox.id);
  const members = useMembers();
  const add = useAddMailboxMember();
  const remove = useRemoveMailboxMember();
  const [picked, setPicked] = useState<string | null>(null);
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
      <div className="flex flex-col gap-4">
        {canManage && addable.length > 0 && (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!picked) return;
              add.mutate(
                { mailboxId: mailbox.id, memberId: picked },
                {
                  onSuccess: () => setPicked(null),
                  onError: () => appToast.error("Access could not be given."),
                },
              );
            }}
          >
            <Select
              className="flex-1"
              placeholder="Choose a person"
              value={picked}
              onChange={(next) => setPicked(next === null ? null : String(next))}
            >
              <Label>Add a person</Label>
              <SelectTrigger />
              <SelectContent items={addable}>
                {(person) => (
                  <SelectItem id={person.id} textValue={person.name}>
                    {person.name}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button type="submit" isDisabled={!picked} isPending={add.isPending}>
              Add
            </Button>
          </form>
        )}
        <Skeleton
          id={`settings-access-${mailbox.id}`}
          data={access.data?.members}
          sample={SAMPLE_ACCESS}
          label="Loading access"
        >
          {(list) => (
            <SettingsGroup>
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
                                remove.mutate(
                                  { mailboxId: mailbox.id, memberId: person.memberId },
                                  {
                                    onError: () =>
                                      appToast.error(`Access for ${name} could not be removed.`),
                                  },
                                ),
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
      </div>
    </SettingsListDialog>
  );
}
