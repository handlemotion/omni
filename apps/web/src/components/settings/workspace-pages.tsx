// Settings pages about the active workspace: what it is and the others you belong to, and who is
// in it. Owners and admins also see each person's personal inbox there (ADR 0017). The mailboxes
// you open and the shared ones are `mailbox-pages.tsx`.
import {
  IconPlus,
  IconCircleX,
  IconGlobe,
  IconInbox,
  IconList,
  IconSend,
  IconTrash,
  IconUserCog,
  IconUserMinus,
} from "@/components/icons/lucide";
import { cn } from "cn";
import { type CSSProperties, useState } from "react";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { Skeleton } from "skullet/react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyField, RenewField } from "@/components/ui/copy-field";
import { appToast } from "@/components/ui/toast";
import {
  useAddDomain,
  useCheckDomain,
  useOnboarding,
  useRemoveDomain,
  useRotateChallenge,
} from "@/hooks/use-onboarding.ts";
import { rememberedChallenge } from "@/lib/onboarding.ts";
import {
  useCancelInvitation,
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useChangeWorkspaceHandle,
  useRenameWorkspace,
  useResendInvitation,
  useUpdateMemberRole,
} from "@/hooks/use-organization.ts";
import { useWorkspaceMailboxes } from "@/hooks/use-mailbox-members.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useRemoveWorkspaceLogo, useUploadWorkspaceLogo } from "@/hooks/use-pictures.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { DnsRecord, OnboardingDomain, OrgMailbox, Workspace } from "@/lib/types.ts";
import { NameInputRow, PersonAvatar } from "./account-pages";
import {
  type InboxOwner,
  MAILBOX_STATUS,
  NewMailboxDialog,
  useMailboxDomains,
} from "./mailbox-pages";
import { SettingsAddRow } from "./kit/settings-add-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsAvatarRow } from "./kit/settings-avatar-row";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import {
  SettingsConfirmDialog,
  SettingsFormDialog,
  SettingsListDialog,
} from "./kit/settings-stacked-dialog";
import { SettingsValueRow } from "./kit/settings-value-row";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** The role a member holds, as people say it. Better Auth stores several as a comma list. */
function roleLabel(role: string) {
  const first = role.split(",")[0]?.trim() ?? role;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Skeleton stand-ins: the shape of what loads (three people), drawn before the first load.
type MemberList = NonNullable<ReturnType<typeof useMembers>["data"]>["members"];
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

/** A handle as it's typed: lowercase letters, digits and single dashes. */
const toHandle = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replace(/^-/u, "");

/** Owners and admins manage the workspace; Better Auth may store several roles. */
export const isManager = (role: string) => /\b(owner|admin)\b/.test(role);

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
  const changeHandle = useChangeWorkspaceHandle();
  const uploadLogo = useUploadWorkspaceLogo();
  const removeLogo = useRemoveWorkspaceLogo();
  const canManage = isManager(member.role);
  const active = workspaces.data?.workspaces.find((workspace) => workspace.id === member.orgId);

  return (
    <SettingsSections>
      <SettingsSection title="Workspace">
        <Skeleton id="settings-workspace" data={active} label="Loading workspace">
          {(workspace) => (
            <SettingsGroup>
              {canManage && (
                <SettingsAvatarRow
                  label="Logo"
                  description="Shown in the switcher. PNG, JPEG, WebP or GIF, up to 2 MB"
                  avatar={<WorkspaceAvatar workspace={workspace} size={32} />}
                  hasImage={!!workspace.logo}
                  busy={uploadLogo.isPending || removeLogo.isPending}
                  onUpload={(file) =>
                    uploadLogo.mutate(file, {
                      onError: (error) =>
                        appToast.error(error.message || "That logo didn't upload."),
                    })
                  }
                  onRemove={() =>
                    removeLogo.mutate(undefined, {
                      onError: () => appToast.error("The logo could not be removed."),
                    })
                  }
                />
              )}
              {canManage ? (
                <NameInputRow
                  id="settings-workspace-name"
                  label="Name"
                  saved={workspace.name}
                  message="Workspace name changed"
                  saving={rename.isPending}
                  onSave={(name) =>
                    rename.mutate(name, {
                      onError: () => appToast.error("The workspace could not be renamed."),
                    })
                  }
                />
              ) : (
                <SettingsValueRow label="Name" value={workspace.name} />
              )}
              {canManage ? (
                <NameInputRow
                  id="settings-workspace-handle"
                  label="Handle"
                  saved={workspace.slug}
                  message="Workspace handle changed"
                  normalize={toHandle}
                  finalize={(handle) => handle.replace(/-+$/u, "")}
                  saving={changeHandle.isPending}
                  onSave={(handle) =>
                    changeHandle.mutate(handle, {
                      onError: (error) =>
                        appToast.error(error.message || "That handle could not be used."),
                    })
                  }
                />
              ) : (
                <SettingsValueRow label="Handle" value={workspace.slug} />
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      {canManage ? (
        <DomainsSection />
      ) : (
        <SettingsSection title="Domains">
          <SettingsEmptyState
            variant="restricted"
            title="Only owners and admins see domains"
            description="Ask one of them to add a domain or check its DNS records."
          />
        </SettingsSection>
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

/** What a stacked dialog over the Domains section is doing, if anything. */
type DomainDialog =
  | { kind: "add" }
  | { kind: "records"; domainId: string }
  | { kind: "remove"; domainId: string };

/**
 * The workspace's mail domains (owners and admins: only they can see or change them). A domain is
 * added here after setup too (ADR 0016); each row's menu opens its DNS records over settings, to
 * copy again or check after a change at the DNS host, or removes it.
 */
function DomainsSection() {
  const { member } = useMember();
  const onboarding = useOnboarding();
  const [dialog, setDialog] = useState<DomainDialog | null>(null);
  const close = () => setDialog(null);
  const domains = onboarding.data?.domains;
  const target =
    dialog && dialog.kind !== "add" ? domains?.find((d) => d.id === dialog.domainId) : undefined;
  const isOwner = /\bowner\b/.test(member.role);

  return (
    <SettingsSection title="Domains">
      <Skeleton id="settings-domains" data={domains} sample={[]} label="Loading domains">
        {(list) =>
          list.length === 0 ? (
            <SettingsEmptyState
              title="No domains yet"
              description="Add the domain your mail is on to create mailboxes there."
              action={
                <Button size="xs" intent="outline" onPress={() => setDialog({ kind: "add" })}>
                  <IconPlus data-slot="icon" />
                  Add a domain
                </Button>
              }
            />
          ) : (
            <SettingsGroup>
              <SettingsAddRow label="Add a domain" onPress={() => setDialog({ kind: "add" })} />
              {list.map((domain) => {
                const state = domainState(domain);
                return (
                  <SettingsRow
                    key={domain.id}
                    icon={IconGlobe}
                    label={domain.domain}
                    description={
                      domain.provider === "purelymail"
                        ? "Hosted by Purelymail"
                        : "Your own mail host"
                    }
                    control={
                      <>
                        <Badge intent={state.intent}>{state.label}</Badge>
                        <SettingsRowMenu
                          label={`Actions for ${domain.domain}`}
                          items={[
                            {
                              icon: IconList,
                              label: "DNS records",
                              onAction: () => setDialog({ kind: "records", domainId: domain.id }),
                            },
                            // A verified domain is released by owners only (ADR 0010); a claim
                            // that never verified, by any owner or admin.
                            ...(isOwner || domain.status !== "verified"
                              ? [
                                  {
                                    icon: IconTrash,
                                    label: "Remove domain",
                                    danger: true,
                                    onAction: () =>
                                      setDialog({ kind: "remove", domainId: domain.id }),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </>
                    }
                  />
                );
              })}
            </SettingsGroup>
          )
        }
      </Skeleton>
      <AddDomainDialog
        isOpen={dialog?.kind === "add"}
        onClose={close}
        onAdded={(domainId) => setDialog({ kind: "records", domainId })}
      />
      {dialog?.kind === "records" && target && (
        <DomainRecordsDialog domain={target} onClose={close} />
      )}
      <RemoveDomainDialog domain={dialog?.kind === "remove" ? target : undefined} onClose={close} />
    </SettingsSection>
  );
}

function AddDomainDialog(props: {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (domainId: string) => void;
}) {
  const add = useAddDomain();
  const [name, setName] = useState("");
  const domain = name.trim();
  return (
    <SettingsFormDialog
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && props.onClose()}
      title="Add a domain"
      description="Next, you add its DNS records to prove it's yours."
      action="Add"
      disabled={!domain}
      saving={add.isPending}
      onSubmit={() =>
        add.mutate(domain, {
          onSuccess: (added) => {
            setName("");
            props.onAdded(added.id);
          },
          onError: (error) => appToast.error(error.message || "That domain could not be added."),
        })
      }
    >
      <TextField isRequired autoFocus value={name} onChange={setName}>
        <Label>Domain</Label>
        <Input placeholder="example.com" autoComplete="off" spellCheck={false} />
      </TextField>
    </SettingsFormDialog>
  );
}

function RemoveDomainDialog(props: { domain: OnboardingDomain | undefined; onClose: () => void }) {
  const remove = useRemoveDomain();
  // Kept while the dialog animates out, so its text doesn't change under it.
  const [shown, setShown] = useState(props.domain);
  if (props.domain && props.domain !== shown) setShown(props.domain);
  const verified = shown?.status === "verified";
  return (
    <SettingsConfirmDialog
      isOpen={!!props.domain}
      onOpenChange={(open) => !open && props.onClose()}
      title={`Remove ${shown?.domain ?? "domain"}?`}
      description={
        verified
          ? "Another workspace can claim it once it's removed. Its mailboxes must be removed first."
          : "It stops waiting for DNS. You can add it again later."
      }
      action="Remove domain"
      saving={remove.isPending}
      onConfirm={() =>
        shown &&
        remove.mutate(shown.id, {
          onSuccess: () => {
            props.onClose();
            appToast.success(`${shown.domain} removed`);
          },
          onError: (error) =>
            appToast.error(error.message || `${shown.domain} could not be removed.`),
        })
      }
    />
  );
}

/** A record as the dialog shows it: Omni's challenge first, then the provider's. */
interface ShownRecord {
  key: string;
  purpose: string;
  kind: string;
  name: string;
  /** Null for the challenge once its one showing is gone (only its hash is stored). */
  value: string | null;
  passes: boolean;
}

function shownRecords(domain: OnboardingDomain): ShownRecord[] {
  const challenge = domain.challenge
    ? [
        {
          key: "challenge",
          purpose: "Links it to this workspace",
          kind: domain.challenge.type,
          name: domain.challenge.name,
          value: rememberedChallenge(domain),
          passes: domain.challenge.verified || domain.challenge.diagnostic?.status === "ok",
        },
      ]
    : [];
  return [
    ...challenge,
    ...domain.records.map((record) => ({
      key: `${record.type} ${record.name}`,
      purpose: RECORD_PURPOSES[record.check],
      kind: recordKind(record),
      name: record.name,
      value:
        record.diagnostic?.suggestion ??
        (record.priority !== undefined ? `${record.priority} ${record.value}` : record.value),
      passes: recordPasses(record),
    })),
  ];
}

function DomainRecordsDialog(props: { domain: OnboardingDomain; onClose: () => void }) {
  const { domain } = props;
  const check = useCheckDomain();
  const rotate = useRotateChallenge();
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
        {shownRecords(domain).map((record) => (
          // A record: what it's for and whether it passes, then its two values to copy.
          <div key={record.key} className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm/4 text-foreground">
                {record.purpose}
                <span className="text-muted-foreground"> ({record.kind})</span>
              </span>
              <Badge intent={record.passes ? "success" : "warning"}>
                {record.passes ? "Found" : "Not found"}
              </Badge>
            </div>
            <div className="flex flex-col gap-2 [--copy-label-width:--spacing(13)]">
              <CopyField label="Host" value={record.name} />
              {record.value !== null ? (
                <CopyField label="Value" value={record.value} />
              ) : (
                !record.passes && (
                  // Shown once, then only its hash is kept: pressing makes a new value. Never on
                  // its own, since it would replace a record that may have just been added.
                  <RenewField
                    label="Value"
                    placeholder="Hidden"
                    tooltip="Show a new value. It replaces the old one."
                    isPending={rotate.isPending}
                    onPress={() =>
                      rotate.mutate(domain.id, {
                        onError: (error) =>
                          appToast.error(error.message || "A new value was not made."),
                      })
                    }
                  />
                )
              )}
            </div>
          </div>
        ))}
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
  | { kind: "revoke"; invitationId: string; email: string }
  | { kind: "inbox"; person: InboxOwner };

/**
 * A person's personal inbox as their People row says it: its address, then its state when it
 * isn't syncing normally. Text in the description, so the row stays as tall as the others.
 */
function InboxDescription({ inboxes }: { inboxes: OrgMailbox[] }) {
  const [first] = inboxes;
  if (!first) return "No inbox";
  const status = MAILBOX_STATUS[first.status];
  return (
    <>
      {first.address}
      {inboxes.length > 1 && ` and ${inboxes.length - 1} more`}
      {status && (
        <span className={cn(status.intent === "danger" && "text-danger-subtle-foreground")}>
          {` · ${status.label}`}
        </span>
      )}
    </>
  );
}

export function PeoplePage() {
  const { member: me } = useMember();
  const members = useMembers();
  const invitations = useInvitations();
  const remove = useRemoveMember();
  const cancel = useCancelInvitation();
  const resend = useResendInvitation();
  const canManage = isManager(me.role);
  // Owners and admins see whose personal inbox exists; the list is theirs only (ADR 0017).
  const workspaceMailboxes = useWorkspaceMailboxes(canManage);
  const domains = useMailboxDomains();
  const pending = invitations.data?.filter((invitation) => invitation.status === "pending");
  const [dialog, setDialog] = useState<PeopleDialog | null>(null);
  const close = () => setDialog(null);
  const personal = workspaceMailboxes.data?.mailboxes.filter((m) => m.kind === "personal");
  // Members alone for everyone else; for owners and admins, members once their inboxes load too.
  const rows = canManage && !personal ? undefined : members.data?.members;
  const canCreateInbox = canManage && !!domains && domains.length > 0;

  return (
    <SettingsSections>
      <SettingsSection title="Members">
        <Skeleton id="settings-members" data={rows} sample={SAMPLE_MEMBERS} label="Loading members">
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
                const inboxes = personal?.filter((m) => m.owner?.memberId === person.id);
                const items = [
                  ...(canCreateInbox && inboxes?.length === 0
                    ? [
                        {
                          icon: IconInbox,
                          label: "Create inbox",
                          onAction: () =>
                            setDialog({
                              kind: "inbox",
                              person: {
                                id: person.id,
                                name,
                                email: person.user.email,
                                isYou: self,
                              },
                            }),
                        },
                      ]
                    : []),
                  ...(editable
                    ? [
                        {
                          icon: IconUserCog,
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
                          icon: IconUserMinus,
                          label: "Remove from workspace",
                          danger: true,
                          onAction: () => setDialog({ kind: "remove", memberId: person.id, name }),
                        },
                      ]
                    : []),
                ];
                return (
                  <SettingsRow
                    key={person.id}
                    avatar={<PersonAvatar name={name} image={person.user.image} />}
                    label={name}
                    hint={self ? "you" : undefined}
                    description={
                      inboxes ? (
                        <InboxDescription inboxes={inboxes} />
                      ) : person.user.name ? (
                        person.user.email
                      ) : undefined
                    }
                    control={
                      <>
                        <RoleBadge role={person.role} />
                        {items.length > 0 && (
                          <SettingsRowMenu label={`Actions for ${name}`} items={items} />
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
          {(list) =>
            list.length === 0 ? (
              <SettingsEmptyState
                title="No pending invitations"
                description="People you invite appear here until they join."
              />
            ) : (
              <SettingsGroup>
                {list.map((invitation) => (
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
                                icon: IconSend,
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
                                icon: IconCircleX,
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
                ))}
              </SettingsGroup>
            )
          }
        </Skeleton>
      </SettingsSection>

      <InviteDialog isOpen={dialog?.kind === "invite"} onClose={close} />
      {dialog?.kind === "role" && <RoleDialog key={dialog.memberId} {...dialog} onClose={close} />}
      {dialog?.kind === "inbox" && domains && (
        <NewMailboxDialog domains={domains} person={dialog.person} onClose={close} />
      )}
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
