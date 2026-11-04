// Settings pages about the active workspace: what it is and the others you belong to, who is in
// it, and who can see each mailbox.
import { lazy, useState } from "react";
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
import { SettingsCollapsibleRow } from "./kit/settings-collapsible-row";
import { SettingsInputRow } from "./kit/settings-input-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsGroupBody,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsMeterRow } from "./kit/settings-meter-row";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsSelectRow } from "./kit/settings-select-row";
import { SettingsToggleRow } from "./kit/settings-toggle-row";
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
        <Skeleton data={active} label="Loading workspace">
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
        <Skeleton data={all} label="Loading workspaces">
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

const ROLE_OPTIONS = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
] as const;

export function PeoplePage() {
  const { member: me } = useMember();
  const members = useMembers();
  const invitations = useInvitations();
  const updateRole = useUpdateMemberRole();
  const remove = useRemoveMember();
  const cancel = useCancelInvitation();
  const canManage = isManager(me.role);
  const pending = invitations.data?.filter((invitation) => invitation.status === "pending");

  return (
    <SettingsSections>
      <SettingsSection title="Members">
        <Skeleton data={members.data?.members} label="Loading members">
          {(list) => (
            <SettingsGroup>
              {list.map((person) => {
                const name = person.user.name || person.user.email;
                const self = person.id === me.id;
                const editable = canManage && !self && !person.role.includes("owner");
                const text = {
                  avatar: <PersonAvatar name={name} image={person.user.image} />,
                  label: name,
                  hint: self ? "you" : undefined,
                  description: person.user.name ? person.user.email : undefined,
                };
                return editable ? (
                  <SettingsSelectRow
                    key={person.id}
                    {...text}
                    label={name}
                    id={`member-role-${person.id}`}
                    options={ROLE_OPTIONS}
                    value={person.role.includes("admin") ? "admin" : "member"}
                    onValueChange={(role) =>
                      updateRole.mutate(
                        { memberId: person.id, role },
                        { onError: () => appToast.error("The role could not be changed.") },
                      )
                    }
                    trailing={
                      <SettingsRowMenu
                        label={`Actions for ${name}`}
                        items={[
                          {
                            label: "Remove from workspace",
                            danger: true,
                            onAction: () =>
                              remove.mutate(person.id, {
                                onError: () => appToast.error(`${name} could not be removed.`),
                              }),
                          },
                        ]}
                      />
                    }
                  />
                ) : (
                  <SettingsValueRow
                    key={person.id}
                    {...text}
                    value={roleLabel(person.role)}
                    tone="muted"
                  />
                );
              })}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      {canManage && <InviteSection />}

      <SettingsSection title="Invitations">
        <Skeleton data={pending} label="Loading invitations">
          {(list) => (
            <SettingsGroup>
              {list.length === 0 ? (
                <SettingsEmptyState
                  title="No pending invitations"
                  description="People you invite show up here until they join."
                />
              ) : (
                list.map((invitation) => (
                  <SettingsRow
                    key={invitation.id}
                    label={invitation.email}
                    description={`${roleLabel(invitation.role ?? "member")} · expires ${DAY.format(new Date(invitation.expiresAt))}`}
                    control={
                      canManage && (
                        <SettingsRowMenu
                          label={`Actions for ${invitation.email}`}
                          items={[
                            {
                              label: "Cancel invitation",
                              danger: true,
                              onAction: () => cancel.mutate(invitation.id),
                            },
                          ]}
                        />
                      )
                    }
                  />
                ))
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
  );
}

function InviteSection() {
  const invite = useInviteMember();
  const [email, setEmail] = useState("");
  const send = () => {
    const address = email.trim();
    if (!address) return;
    invite.mutate(
      { email: address },
      {
        onSuccess: () => {
          setEmail("");
          appToast.success(`Invitation sent to ${address}`);
        },
        onError: (error) => appToast.error(error.message || "The invitation was not sent."),
      },
    );
  };
  return (
    <SettingsSection title="Invite">
      <SettingsGroup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <SettingsInputRow
            id="settings-invite-email"
            label="Email"
            description="They get a link to join as a member."
            type="email"
            placeholder="name@company.com"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            trailing={
              <Button type="submit" isDisabled={!email.trim()} isPending={invite.isPending}>
                Invite
              </Button>
            }
          />
        </form>
      </SettingsGroup>
    </SettingsSection>
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
        <Skeleton data={mine} label="Loading mailboxes">
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
        <Skeleton data={busy} label="Loading counts">
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

/** A shared mailbox opens to its workspace's members, each with a switch for access. */
function SharedMailboxRow({ mailbox, canManage }: { mailbox: Mailbox; canManage: boolean }) {
  const access = useMailboxMembers(mailbox.id);
  const members = useMembers();
  const add = useAddMailboxMember();
  const remove = useRemoveMailboxMember();
  const granted = new Set(access.data?.members.map((person) => person.memberId));
  const count = access.data?.members.length;

  return (
    <SettingsCollapsibleRow
      label={mailboxName(mailbox)}
      description={mailbox.address}
      value={count === undefined ? undefined : `${count} ${count === 1 ? "person" : "people"}`}
    >
      {canManage
        ? members.data?.members.map((person) => {
            const name = person.user.name || person.user.email;
            const change = { mailboxId: mailbox.id, memberId: person.id };
            return (
              <SettingsToggleRow
                key={person.id}
                id={`mailbox-${mailbox.id}-${person.id}`}
                avatar={<PersonAvatar name={name} image={person.user.image} />}
                label={name}
                description={person.user.name ? person.user.email : undefined}
                checked={granted.has(person.id)}
                disabled={add.isPending || remove.isPending}
                onCheckedChange={(on) =>
                  (on ? add : remove).mutate(change, {
                    onError: () => appToast.error(`Access for ${name} could not be changed.`),
                  })
                }
              />
            );
          })
        : access.data?.members.map((person) => (
            <SettingsRow
              key={person.memberId}
              avatar={<PersonAvatar name={person.name || person.email} image={person.image} />}
              label={person.name || person.email}
              description={person.name ? person.email : undefined}
            />
          ))}
      {!canManage && access.data?.members.length === 0 && (
        <SettingsGroupBody>Nobody has access yet.</SettingsGroupBody>
      )}
    </SettingsCollapsibleRow>
  );
}
