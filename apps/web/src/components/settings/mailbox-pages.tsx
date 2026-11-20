import { IconPlus, IconUserMinus } from "@/components/icons/central";
import { lazy, useState } from "react";
import { Skeleton, SkeletonSuspense } from "skullet/react";
import { Contain } from "@/components/errors/error-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChartConfig } from "@/components/ui/chart";
import { Label } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { appToast } from "@/components/ui/toast";
import { useCounts, useMailboxes } from "@/hooks/use-mail.ts";
import {
  useAddMailboxMember,
  useMailboxMembers,
  useRemoveMailboxMember,
  useWorkspaceMailboxes,
} from "@/hooks/use-mailbox-members.ts";
import { useOnboarding } from "@/hooks/use-onboarding.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import { LANES, type Lane, type Mailbox, type OrgMailbox } from "@/lib/types.ts";
import { PersonAvatar } from "./account-pages";
import { SettingsAddRow } from "./kit/settings-add-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsLinkRow } from "./kit/settings-link-row";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsSeriesRow } from "./kit/settings-series-row";
import {
  SettingsConfirmDialog,
  SettingsFormDialog,
  SettingsListDialog,
} from "./kit/settings-stacked-dialog";
import { SettingsValueRow } from "./kit/settings-value-row";
import { isManager } from "./workspace-pages";
import { NewMailboxDialog, useOwnInboxCreation } from "./new-mailbox-dialog";

const SettingsChart = lazy(() =>
  import("./kit/settings-chart").then((module) => ({ default: module.SettingsChart })),
);

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

function mailboxName(mailbox: { address: string }) {
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** A mailbox that isn't syncing normally, in words; null while it is. */
export const MAILBOX_STATUS: Record<
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
const threads = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

type AccessList = NonNullable<ReturnType<typeof useMailboxMembers>["data"]>["members"];
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
const SAMPLE_ROWS = SAMPLE_MAILBOXES.map((mailbox) => ({ mailbox, row: undefined }));
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
  orphaned: false,
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

function useOwnMailboxes() {
  const { member } = useMember();
  const mailboxes = useMailboxes();
  return mailboxes.data?.filter((mailbox) => mailbox.orgId === member.orgId);
}

/**
 * Domains a new mailbox can go on: verified here, and accepted by the provider. Not a domain
 * whose mail stays at Google: its accounts connect from Google instead.
 */
export function useMailboxDomains() {
  const onboarding = useOnboarding();
  return onboarding.data?.domains.filter(
    (domain) =>
      domain.status === "verified" &&
      domain.provider !== "gmail" &&
      (domain.provider === "imap" || domain.added),
  );
}

export function InboxesPage() {
  const mine = useOwnMailboxes();
  const counts = useCounts();
  const own = useOwnInboxCreation();
  const rows =
    mine && counts.data
      ? mine.map((mailbox) => ({
          mailbox,
          row: counts.data.counts.find((count) => count.mailboxId === mailbox.id),
        }))
      : undefined;
  const busy = rows?.flatMap(({ mailbox, row }) =>
    row && row.inbox > 0 ? [{ mailbox, row }] : [],
  );

  return (
    <SettingsSections>
      <SettingsSection title="Mailboxes">
        <Skeleton
          id="settings-mailboxes"
          data={rows}
          sample={SAMPLE_ROWS}
          label="Loading mailboxes"
        >
          {(list) =>
            list.length === 0 ? (
              <SettingsEmptyState
                title="No mailboxes"
                description={
                  own.personal
                    ? undefined
                    : "An owner or admin can create your inbox or add you to a shared one."
                }
                action={
                  own.personal &&
                  own.domains.length > 0 && (
                    <Button size="sm" intent="outline" onPress={own.open}>
                      <IconPlus data-slot="icon" />
                      Create an inbox
                    </Button>
                  )
                }
              />
            ) : (
              <SettingsGroup>
                {own.personal && own.domains.length > 0 && (
                  <SettingsAddRow label="Create an inbox" onPress={own.open} />
                )}
                {list.map(({ mailbox, row }) => (
                  <OwnMailboxRow key={mailbox.id} mailbox={mailbox} unread={row?.unread ?? 0} />
                ))}
              </SettingsGroup>
            )
          }
        </Skeleton>
        {own.dialog}
      </SettingsSection>

      <SettingsSection
        title="Inbox by lane"
        info="Threads in each inbox now, by the lane triage put them in."
      >
        <Skeleton id="settings-inbox" data={busy} sample={[]} label="Loading counts">
          {(list) =>
            list.length === 0 ? (
              <SettingsEmptyState
                title="Inbox zero"
                description="Nothing waits in any inbox right now."
              />
            ) : (
              <SettingsGroup>
                <Contain fallback={null}>
                  <SkeletonSuspense skeleton={<div className="h-62" />}>
                    <SettingsChart
                      label="Threads in each inbox by lane"
                      config={LANE_CHART}
                      dataKey="mailbox"
                      data={list.map(({ mailbox, row }) => ({
                        mailbox: mailboxName(mailbox),
                        ...row.lanes,
                      }))}
                    />
                  </SkeletonSuspense>
                </Contain>
                {LANES.map((lane, i) => {
                  const total = list.reduce((sum, { row }) => sum + row.lanes[lane], 0);
                  return (
                    <SettingsSeriesRow
                      key={lane}
                      color={`var(--chart-${i + 1})`}
                      label={LANE_LABELS[lane]}
                      value={threads(total)}
                    />
                  );
                })}
              </SettingsGroup>
            )
          }
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
  );
}

function OwnMailboxRow({ mailbox, unread }: { mailbox: Mailbox; unread: number }) {
  const shared = mailbox.kind === "shared";
  const count = useMailboxMembers(mailbox.id, shared).data?.members.length;
  const who = shared ? (count === undefined ? null : people(count)) : "Only you";
  return (
    <SettingsValueRow
      label={mailboxName(mailbox)}
      badge={<MailboxStatusBadge mailbox={mailbox} />}
      description={who ? `${mailbox.address} · ${who}` : mailbox.address}
      value={unread > 0 ? <span className="tabular-nums">{unread} unread</span> : ""}
      tone="muted"
    />
  );
}

interface SharedRow {
  id: string;
  address: string;
  status: Mailbox["status"];
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
  const shared: SharedRow[] | undefined = canManage
    ? all.data?.inboxes.filter((mailbox) => mailbox.kind === "shared")
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
          {(list) =>
            list.length === 0 ? (
              <SettingsEmptyState
                title="No shared mailboxes"
                description={canManage ? undefined : "An owner or admin can add you to one."}
                action={
                  canAdd && (
                    <Button size="sm" intent="outline" onPress={() => setAdding(true)}>
                      <IconPlus data-slot="icon" />
                      Add a shared mailbox
                    </Button>
                  )
                }
              />
            ) : (
              <SettingsGroup>
                {canAdd && (
                  <SettingsAddRow label="Add a shared mailbox" onPress={() => setAdding(true)} />
                )}
                {list.map((mailbox) => (
                  <SharedMailboxRow
                    key={mailbox.id}
                    mailbox={mailbox}
                    onOpen={() => setOpenId(mailbox.id)}
                  />
                ))}
              </SettingsGroup>
            )
          }
        </Skeleton>
      </SettingsSection>
      {open && (
        <MailboxAccessDialog mailbox={open} canManage={canManage} onClose={() => setOpenId(null)} />
      )}
      {adding && domains && <NewMailboxDialog domains={domains} onClose={() => setAdding(false)} />}
    </SettingsSections>
  );
}

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
        {(list) =>
          list.length === 0 ? (
            <SettingsEmptyState
              title="Nobody yet"
              action={
                canManage &&
                addable.length > 0 && (
                  <Button size="sm" intent="outline" onPress={() => setDialog({ kind: "add" })}>
                    <IconPlus data-slot="icon" />
                    Add a person
                  </Button>
                )
              }
            />
          ) : (
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
                              icon: IconUserMinus,
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
          )
        }
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

export function PersonSelect(props: {
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
