// Settings for a shared inbox's helpdesk (ADR 0021, ADR 0023), one inbox at a time:
// - Assignment: round-robin new customer conversations among the people on the inbox.
// - Response targets: per priority, how soon the first reply, each next reply and the resolution
//   are due. A priority without targets has no due times.
// - Business hours: when the targets count, or around the clock.
// - Tags: the inbox's labels for conversations.
// Everyone on the inbox reads these; owners and admins change assignment, targets and hours (the
// API answers 403 otherwise). Anyone on the inbox manages its tags.
import { IconPencil, IconTrash } from "@/components/icons/central";
import { parseTime, Time } from "@internationalized/date";
import { useMemo, useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { ComboBox, ComboBoxContent, ComboBoxInput, ComboBoxItem } from "@/components/ui/combo-box";
import { Label } from "@/components/ui/field";
import { AriaInput } from "@/components/ui/aria-input";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Switch, SwitchField } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import { TimeField, TimeInput } from "@/components/ui/time-field";
import { appToast } from "@/components/ui/toast";
import { useCreateTag, useDeleteTag, useTags, useUpdateTag } from "@/hooks/use-conversation.ts";
import { useMailboxes } from "@/hooks/use-mail.ts";
import { useMember } from "@/hooks/use-session.ts";
import {
  useDeleteBusinessHours,
  useDeleteSlaPolicy,
  usePutBusinessHours,
  usePutSlaPolicy,
  useSetAutoAssign,
  useSlaSettings,
} from "@/hooks/use-sla.ts";
import type { Priority, SlaPolicy, SlaSettings, Tag } from "@/lib/types.ts";
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
import { SettingsSelectRow } from "./kit/settings-select-row";
import {
  SettingsConfirmDialog,
  SettingsFormDialog,
  SettingsRenameDialog,
} from "./kit/settings-stacked-dialog";
import { SettingsToggleRow } from "./kit/settings-toggle-row";
import { SettingsValueRow } from "./kit/settings-value-row";
import { isManager } from "./workspace-pages";

/** Most urgent first, as an agent reads them. */
const PRIORITY_ORDER: readonly Priority[] = ["urgent", "high", "normal", "low"];
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** The shared inboxes the signed-in member is on, in the active workspace. */
function useSharedInboxes() {
  const { member } = useMember();
  const mailboxes = useMailboxes();
  return mailboxes.data?.filter(
    (mailbox) => mailbox.orgId === member.orgId && mailbox.kind === "shared",
  );
}

export function HelpdeskPage() {
  const inboxes = useSharedInboxes();
  const [chosen, setChosen] = useState<string | null>(null);
  const inbox = inboxes?.find((candidate) => candidate.id === chosen) ?? inboxes?.[0];

  if (inboxes && !inbox) {
    return (
      <SettingsSections>
        <SettingsSection title="Inbox">
          <SettingsEmptyState
            title="No shared inboxes"
            description="Helpdesk settings belong to a shared inbox. An owner or admin can add one on Shared."
          />
        </SettingsSection>
      </SettingsSections>
    );
  }

  return (
    <SettingsSections>
      {inboxes && inboxes.length > 1 && inbox && (
        <SettingsSection title="Inbox">
          <SettingsGroup>
            <SettingsSelectRow
              id="helpdesk-inbox"
              label="Inbox"
              description="The settings below are for this inbox."
              value={inbox.id}
              options={inboxes.map((candidate) => ({
                value: candidate.id,
                // The full address: two domains can share a local part ("support").
                label: candidate.address,
              }))}
              onValueChange={setChosen}
            />
          </SettingsGroup>
        </SettingsSection>
      )}
      {inbox && <InboxSettings key={inbox.id} mailboxId={inbox.id} />}
    </SettingsSections>
  );
}

// Skeleton stand-ins, the shape of what loads.
const SAMPLE_SETTINGS = {
  autoAssign: false,
  businessHours: null,
  policies: [],
} as unknown as SlaSettings;
const SAMPLE_TAGS = ["Billing", "Bug", "Refund"].map((name, i) => ({
  id: `sample-${i}`,
  name,
  color: null,
})) as unknown as Tag[];

type Dialog =
  | { kind: "targets"; priority: Priority }
  | { kind: "hours" }
  | { kind: "add-tag" }
  | { kind: "rename-tag"; tag: Tag }
  | { kind: "delete-tag"; tag: Tag };

function InboxSettings({ mailboxId }: { mailboxId: string }) {
  const { member } = useMember();
  const canManage = isManager(member.role);
  const settings = useSlaSettings(mailboxId);
  const tags = useTags(mailboxId);
  const autoAssign = useSetAutoAssign();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const onlyManagers = canManage ? undefined : "Only owners and admins change this.";

  return (
    <>
      <SettingsSection title="Assignment">
        <Skeleton
          id={`settings-assignment-${mailboxId}`}
          data={settings.data}
          sample={SAMPLE_SETTINGS}
          label="Loading assignment"
        >
          {(data) => (
            <SettingsGroup>
              <SettingsToggleRow
                id="helpdesk-auto-assign"
                label="Assign new conversations"
                description={
                  onlyManagers ?? "In turn to each person on the inbox, as customers write in."
                }
                checked={data.autoAssign}
                disabled={!canManage}
                onCheckedChange={(enabled) =>
                  autoAssign.mutate(
                    { mailboxId, enabled },
                    { onError: () => appToast.error("Auto-assign was not changed.") },
                  )
                }
              />
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <SettingsSection
        title="Response targets"
        info="How soon each priority gets a reply and a resolution. A priority without targets has no due times."
      >
        <Skeleton
          id={`settings-targets-${mailboxId}`}
          data={settings.data}
          sample={SAMPLE_SETTINGS}
          label="Loading response targets"
        >
          {(data) => (
            <SettingsGroup>
              {PRIORITY_ORDER.map((priority) => {
                const policy = data.policies.find((p) => p.priority === priority);
                const value = (
                  <span className="tabular-nums">{policy ? targetsSummary(policy) : "None"}</span>
                );
                const description =
                  policy && !policy.businessHoursOnly && data.businessHours
                    ? "Counts around the clock"
                    : undefined;
                return canManage ? (
                  <SettingsLinkRow
                    key={priority}
                    label={PRIORITY_LABELS[priority]}
                    description={description}
                    value={value}
                    onPress={() => setDialog({ kind: "targets", priority })}
                  />
                ) : (
                  <SettingsValueRow
                    key={priority}
                    label={PRIORITY_LABELS[priority]}
                    description={description}
                    value={value}
                    tone="muted"
                  />
                );
              })}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <SettingsSection
        title="Business hours"
        info="Targets count only while the inbox is open, unless a priority counts around the clock."
      >
        <Skeleton
          id={`settings-hours-${mailboxId}`}
          data={settings.data}
          sample={SAMPLE_SETTINGS}
          label="Loading business hours"
        >
          {(data) => {
            const hours = data.businessHours;
            const label = "Open";
            const description = hours ? hours.timezone.replaceAll("_", " ") : undefined;
            const value = <span className="tabular-nums">{hoursSummary(hours)}</span>;
            return (
              <SettingsGroup>
                {canManage ? (
                  <SettingsLinkRow
                    label={label}
                    description={description}
                    value={value}
                    onPress={() => setDialog({ kind: "hours" })}
                  />
                ) : (
                  <SettingsValueRow
                    label={label}
                    description={description}
                    value={value}
                    tone="muted"
                  />
                )}
              </SettingsGroup>
            );
          }}
        </Skeleton>
      </SettingsSection>

      <SettingsSection title="Tags" info="Labels for this inbox's conversations.">
        <Skeleton
          id={`settings-tags-${mailboxId}`}
          data={tags.data}
          sample={SAMPLE_TAGS}
          label="Loading tags"
        >
          {(list) =>
            list.length === 0 ? (
              <SettingsEmptyState
                title="No tags"
                action={
                  <Button size="sm" intent="outline" onPress={() => setDialog({ kind: "add-tag" })}>
                    Add a tag
                  </Button>
                }
              />
            ) : (
              <SettingsGroup>
                <SettingsAddRow label="Add a tag" onPress={() => setDialog({ kind: "add-tag" })} />
                {list.map((tag) => (
                  <SettingsRow
                    key={tag.id}
                    label={tag.name}
                    control={
                      <SettingsRowMenu
                        label={`Actions for ${tag.name}`}
                        items={[
                          {
                            icon: IconPencil,
                            label: "Rename",
                            onAction: () => setDialog({ kind: "rename-tag", tag }),
                          },
                          {
                            icon: IconTrash,
                            label: "Delete",
                            danger: true,
                            onAction: () => setDialog({ kind: "delete-tag", tag }),
                          },
                        ]}
                      />
                    }
                  />
                ))}
              </SettingsGroup>
            )
          }
        </Skeleton>
      </SettingsSection>

      {dialog?.kind === "targets" && settings.data && (
        <TargetsDialog
          mailboxId={mailboxId}
          priority={dialog.priority}
          policy={settings.data.policies.find((p) => p.priority === dialog.priority)}
          hasHours={!!settings.data.businessHours}
          onClose={close}
        />
      )}
      {dialog?.kind === "hours" && settings.data && (
        <HoursDialog mailboxId={mailboxId} hours={settings.data.businessHours} onClose={close} />
      )}
      {dialog?.kind === "add-tag" && <AddTagDialog mailboxId={mailboxId} onClose={close} />}
      {dialog?.kind === "rename-tag" && (
        <RenameTagDialog mailboxId={mailboxId} tag={dialog.tag} onClose={close} />
      )}
      <DeleteTagDialog
        mailboxId={mailboxId}
        tag={dialog?.kind === "delete-tag" ? dialog.tag : null}
        onClose={close}
      />
    </>
  );
}

// Durations -------------------------------------------------------------------------------------

type Unit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const UNITS: { value: Unit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

/** Minutes as the fewest words: "30 min", "4 h", "1 h 30 min", "2 d". */
function formatMinutes(total: number) {
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  return (
    [days && `${days} d`, hours && `${hours} h`, minutes && `${minutes} min`]
      .filter(Boolean)
      .join(" ") || "0 min"
  );
}

/** "First reply 1 h · Resolve 2 d": the targets that are set, in the order they fall due. */
function targetsSummary(policy: SlaPolicy) {
  const parts = [
    policy.firstResponseMinutes && `First reply ${formatMinutes(policy.firstResponseMinutes)}`,
    policy.nextResponseMinutes && `Next ${formatMinutes(policy.nextResponseMinutes)}`,
    policy.resolutionMinutes && `Resolve ${formatMinutes(policy.resolutionMinutes)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "None";
}

/** A target as the dialog edits it: a whole number of the largest unit that fits exactly. */
function toAmount(minutes: number | null | undefined): { amount: number; unit: Unit } {
  if (!minutes) return { amount: Number.NaN, unit: "hours" };
  if (minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

const fromAmount = ({ amount, unit }: { amount: number; unit: Unit }) =>
  Number.isFinite(amount) && amount > 0 ? Math.round(amount * UNIT_MINUTES[unit]) : null;

const TARGET_FIELDS = [
  { key: "firstResponseMinutes", label: "First reply within" },
  { key: "nextResponseMinutes", label: "Each next reply within" },
  { key: "resolutionMinutes", label: "Resolved within" },
] as const;
type TargetKey = (typeof TARGET_FIELDS)[number]["key"];

/** One priority's three targets; all empty stops tracking it. */
function TargetsDialog(props: {
  mailboxId: string;
  priority: Priority;
  policy: SlaPolicy | undefined;
  hasHours: boolean;
  onClose: () => void;
}) {
  const { mailboxId, priority, policy } = props;
  const put = usePutSlaPolicy();
  const remove = useDeleteSlaPolicy();
  const [values, setValues] = useState(
    () =>
      Object.fromEntries(TARGET_FIELDS.map(({ key }) => [key, toAmount(policy?.[key])])) as Record<
        TargetKey,
        { amount: number; unit: Unit }
      >,
  );
  const [businessHoursOnly, setBusinessHoursOnly] = useState(policy?.businessHoursOnly ?? true);
  const minutes = Object.fromEntries(
    TARGET_FIELDS.map(({ key }) => [key, fromAmount(values[key])]),
  ) as Record<TargetKey, number | null>;
  const tracked = Object.values(minutes).some((value) => value !== null);
  const tooLong = Object.values(minutes).some((value) => value !== null && value > 525_600);
  const options = {
    onSuccess: props.onClose,
    onError: () => appToast.error("The targets were not saved."),
  };

  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={`${PRIORITY_LABELS[priority]} priority`}
      description="Leave a target empty to not track it."
      action="Save"
      disabled={tooLong || (!tracked && !policy)}
      saving={put.isPending || remove.isPending}
      onSubmit={() =>
        tracked
          ? put.mutate({ mailboxId, priority, targets: { ...minutes, businessHoursOnly } }, options)
          : remove.mutate({ mailboxId, priority }, options)
      }
    >
      {TARGET_FIELDS.map(({ key, label }) => (
        <div key={key} className="flex items-end gap-2">
          <NumberField
            className="flex-1"
            minValue={1}
            step={1}
            value={values[key].amount}
            onChange={(amount) => setValues((v) => ({ ...v, [key]: { ...v[key], amount } }))}
          >
            <Label>{label}</Label>
            <AriaInput className="tabular-nums" placeholder="Not tracked" />
          </NumberField>
          <Select
            aria-label={`${label}, unit`}
            className="w-28"
            value={values[key].unit}
            onChange={(unit) =>
              unit && setValues((v) => ({ ...v, [key]: { ...v[key], unit: unit as Unit } }))
            }
          >
            <SelectTrigger />
            <SelectContent items={UNITS}>
              {(unit) => (
                <SelectItem id={unit.value} textValue={unit.label}>
                  {unit.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      ))}
      {props.hasHours && (
        <SwitchField isSelected={!businessHoursOnly} onChange={(on) => setBusinessHoursOnly(!on)}>
          <Switch>Count around the clock, not only in business hours</Switch>
        </SwitchField>
      )}
    </SettingsFormDialog>
  );
}

// Business hours --------------------------------------------------------------------------------

type BusinessHours = NonNullable<SlaSettings["businessHours"]>;
/** Monday first, as a work week reads; the API counts from Sunday (0). */
const WEEK = [
  { day: 1, label: "Monday", short: "Mon" },
  { day: 2, label: "Tuesday", short: "Tue" },
  { day: 3, label: "Wednesday", short: "Wed" },
  { day: 4, label: "Thursday", short: "Thu" },
  { day: 5, label: "Friday", short: "Fri" },
  { day: 6, label: "Saturday", short: "Sat" },
  { day: 0, label: "Sunday", short: "Sun" },
] as const;

/** "Mon–Fri 9:00–17:00", "Always", or each distinct day listed. */
function hoursSummary(hours: BusinessHours | null) {
  if (!hours) return "Always";
  // Days that share hours read as one run: "Mon–Fri 9:00–17:00 · Sat 10:00–14:00".
  const runs: { from: string; to: string; span: string }[] = [];
  for (const { day, short } of WEEK) {
    const windows = hours.windows.filter((w) => w.day === day);
    if (windows.length === 0) continue;
    const span = windows.map((w) => `${trimHour(w.start)}–${trimHour(w.end)}`).join(", ");
    const last = runs.at(-1);
    const previous = WEEK[WEEK.findIndex((d) => d.day === day) - 1]?.short;
    if (last && last.span === span && last.to === previous) last.to = short;
    else runs.push({ from: short, to: short, span });
  }
  return runs
    .map((run) => `${run.from === run.to ? run.from : `${run.from}–${run.to}`} ${run.span}`)
    .join(" · ");
}

const trimHour = (time: string) => time.replace(/^0(\d)/, "$1");

/** Every IANA zone the browser knows, the inbox's own first if the browser lacks it. */
function useTimeZones(current: string) {
  return useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    const all = zones.includes(current) ? zones : [current, ...zones];
    return all.map((zone) => ({ id: zone, label: zone.replaceAll("_", " ") }));
  }, [current]);
}

interface DayHours {
  open: boolean;
  start: Time;
  end: Time;
}

/** "24:00" (the end of the day) edits as midnight, and midnight as an end saves as "24:00". */
const toTime = (value: string) => (value === "24:00" ? new Time(0, 0) : parseTime(value));
const fromTime = (time: Time, end: boolean) => {
  const text = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
  return end && text === "00:00" ? "24:00" : text;
};

/**
 * When the inbox is open: a time zone and one span per day, or around the clock. A day with
 * split hours (two windows) edits as its first; saving keeps the holidays.
 */
function HoursDialog(props: {
  mailboxId: string;
  hours: BusinessHours | null;
  onClose: () => void;
}) {
  const { mailboxId, hours } = props;
  const put = usePutBusinessHours();
  const remove = useDeleteBusinessHours();
  const [alwaysOpen, setAlwaysOpen] = useState(!hours);
  const [timezone, setTimezone] = useState(
    hours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const zones = useTimeZones(timezone);
  const [days, setDays] = useState<Record<number, DayHours>>(() =>
    Object.fromEntries(
      WEEK.map(({ day }) => {
        const window = hours?.windows.find((w) => w.day === day);
        const weekday = day >= 1 && day <= 5;
        return [
          day,
          window
            ? { open: true, start: toTime(window.start), end: toTime(window.end) }
            : { open: !hours && weekday, start: new Time(9), end: new Time(17) },
        ];
      }),
    ),
  );
  const windows = WEEK.filter(({ day }) => days[day]!.open).map(({ day }) => ({
    day,
    start: fromTime(days[day]!.start, false),
    end: fromTime(days[day]!.end, true),
  }));
  // No open day isn't "never open": the SLA math counts every minute for an empty schedule
  // (`addBusinessMinutes`), so ask for a day or around the clock instead.
  const invalid = windows.length === 0 || windows.some((w) => w.start >= w.end);
  const options = {
    onSuccess: props.onClose,
    onError: (error: Error) => appToast.error(error.message || "The hours were not saved."),
  };
  const setDay = (day: number, patch: Partial<DayHours>) =>
    setDays((current) => ({ ...current, [day]: { ...current[day]!, ...patch } }));

  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Business hours"
      action="Save"
      disabled={(alwaysOpen && !hours) || (!alwaysOpen && invalid)}
      saving={put.isPending || remove.isPending}
      onSubmit={() =>
        alwaysOpen
          ? remove.mutate({ mailboxId }, options)
          : put.mutate(
              { mailboxId, hours: { timezone, windows, holidays: hours?.holidays ?? [] } },
              options,
            )
      }
    >
      <SwitchField isSelected={alwaysOpen} onChange={setAlwaysOpen}>
        <Switch>Open around the clock</Switch>
      </SwitchField>
      {!alwaysOpen && (
        <>
          <ComboBox
            selectedKey={timezone}
            onSelectionChange={(zone) => zone && setTimezone(String(zone))}
            defaultItems={zones}
          >
            <Label>Time zone</Label>
            <ComboBoxInput />
            <ComboBoxContent items={zones}>
              {(zone) => (
                <ComboBoxItem id={zone.id} textValue={zone.label}>
                  {zone.label}
                </ComboBoxItem>
              )}
            </ComboBoxContent>
          </ComboBox>
          <div className="flex flex-col gap-2">
            {WEEK.map(({ day, label }) => {
              const value = days[day]!;
              return (
                <div key={day} className="flex h-8 items-center gap-2">
                  <CheckboxField
                    className="w-32"
                    isSelected={value.open}
                    onChange={(open) => setDay(day, { open })}
                  >
                    <Checkbox>{label}</Checkbox>
                  </CheckboxField>
                  {value.open && (
                    <>
                      <TimeField
                        aria-label={`${label} opens`}
                        hourCycle={24}
                        value={value.start}
                        onChange={(start) => start && setDay(day, { start: start as Time })}
                      >
                        <TimeInput />
                      </TimeField>
                      <span className="text-muted-foreground">–</span>
                      <TimeField
                        aria-label={`${label} closes`}
                        hourCycle={24}
                        value={value.end}
                        onChange={(end) => end && setDay(day, { end: end as Time })}
                      >
                        <TimeInput />
                      </TimeField>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </SettingsFormDialog>
  );
}

// Tags ------------------------------------------------------------------------------------------

function AddTagDialog({ mailboxId, onClose }: { mailboxId: string; onClose: () => void }) {
  const create = useCreateTag();
  const [name, setName] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title="Add a tag"
      action="Add"
      disabled={!name.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          { mailboxId, name: name.trim() },
          { onSuccess: onClose, onError: () => appToast.error("The tag was not added.") },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={64} value={name} onChange={setName}>
        <Label>Name</Label>
        <Input placeholder="Billing" autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}

function RenameTagDialog(props: { mailboxId: string; tag: Tag; onClose: () => void }) {
  const update = useUpdateTag();
  return (
    <SettingsRenameDialog
      title="Rename tag"
      label="Name"
      name={props.tag.name}
      maxLength={64}
      saving={update.isPending}
      onClose={props.onClose}
      onSave={(name) =>
        update.mutate(
          { mailboxId: props.mailboxId, tagId: props.tag.id, name },
          {
            onSuccess: props.onClose,
            onError: (error) =>
              appToast.error(
                error.message.includes("409") || /taken|exists/i.test(error.message)
                  ? `A tag named ${name} already exists.`
                  : "The tag was not renamed.",
              ),
          },
        )
      }
    />
  );
}

function DeleteTagDialog(props: { mailboxId: string; tag: Tag | null; onClose: () => void }) {
  const remove = useDeleteTag();
  const { tag } = props;
  return (
    <SettingsConfirmDialog
      isOpen={!!tag}
      onOpenChange={(open) => !open && props.onClose()}
      title="Delete tag?"
      description={`${tag?.name ?? "It"} comes off every conversation in this inbox.`}
      action="Delete"
      saving={remove.isPending}
      onConfirm={() =>
        tag &&
        remove.mutate(
          { mailboxId: props.mailboxId, tagId: tag.id },
          {
            onSuccess: props.onClose,
            onError: () => appToast.error(`${tag.name} was not deleted.`),
          },
        )
      }
    />
  );
}
