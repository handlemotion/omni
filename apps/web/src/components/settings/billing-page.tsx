// The active workspace's plan (ADR 0015): its state, this month's AI triage against the
// allowance, and the two ways out to Stripe (Checkout to start or restart the plan, the customer
// portal to manage it). Everything shown is `GET /api/billing`; prices, invoices and cards live in
// Stripe and are reached through the portal. Owners and admins (`canManage`) get the actions;
// everyone else reads the same facts.
import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Label } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { appToast } from "@/components/ui/toast";
import { useBilling, useOpenBillingPortal, useStartCheckout } from "@/hooks/use-billing.ts";
import { SettingsButtonRow } from "./kit/settings-button-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsMeterRow } from "./kit/settings-meter-row";
import { SettingsRow, settingsRowTextEndClassName } from "./kit/settings-row";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";
import { SettingsValueRow } from "./kit/settings-value-row";

type Billing = NonNullable<ReturnType<typeof useBilling>["data"]>;
type EnabledBilling = Extract<Billing, { enabled: true }>;
type Subscription = NonNullable<EnabledBilling["subscription"]>;
type Triage = NonNullable<EnabledBilling["triage"]>;
type Interval = EnabledBilling["intervals"][number];

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const NUMBER = new Intl.NumberFormat();
const day = (iso: string) => DAY.format(new Date(iso));

// Skeleton stand-ins: an active monthly plan part way through its month.
const SAMPLE_PLAN: Billing = {
  enabled: true,
  readOnly: false,
  canManage: true,
  intervals: ["month"],
  trialDays: 0,
  subscription: {
    status: "active",
    interval: "month",
    periodEnd: "2026-12-04T00:00:00.000Z",
    trialEnd: null,
    cancelAtPeriodEnd: false,
  },
  triage: null,
};
const SAMPLE_TRIAGE: Triage = {
  used: 120,
  allowance: 500,
  periodEnd: "2026-12-04T00:00:00.000Z",
  pausedUntil: null,
};

const INTERVAL_LABELS: Record<Interval, string> = { month: "Monthly", year: "Yearly" };

/** Stripe's subscription statuses in a word, and the badge colour each reads in. */
const STATUS: Record<
  string,
  { label: string; intent: "success" | "info" | "warning" | "danger" | "secondary" }
> = {
  active: { label: "Active", intent: "success" },
  trialing: { label: "Trial", intent: "info" },
  past_due: { label: "Past due", intent: "warning" },
  incomplete: { label: "Incomplete", intent: "warning" },
  unpaid: { label: "Unpaid", intent: "danger" },
  canceled: { label: "Canceled", intent: "secondary" },
  incomplete_expired: { label: "Expired", intent: "secondary" },
  paused: { label: "Paused", intent: "secondary" },
};
const NO_PLAN = { label: "No plan", intent: "secondary" } as const;

/** The one date that matters for the plan now, and what it is. */
function planDate(subscription: Subscription) {
  const { status, periodEnd, trialEnd, cancelAtPeriodEnd } = subscription;
  if (status === "trialing" && !cancelAtPeriodEnd) {
    const end = trialEnd ?? periodEnd;
    return end ? { label: "Trial ends", value: day(end) } : null;
  }
  if (!periodEnd) return null;
  if (status === "canceled") return { label: "Ended", value: day(periodEnd) };
  if (status === "active" || status === "past_due" || status === "trialing")
    return { label: cancelAtPeriodEnd ? "Ends" : "Renews", value: day(periodEnd) };
  return null;
}

export function BillingPage() {
  const billing = useBilling();
  const data = billing.data;
  const triage = data?.enabled ? data.triage : undefined;
  const failed = billing.isError && (
    <SettingsGroup>
      <SettingsEmptyState title="Billing didn't load" description="Try again in a moment." />
    </SettingsGroup>
  );

  return (
    <SettingsSections>
      <SettingsSection title="Plan">
        <Skeleton
          id="settings-billing-plan"
          data={data}
          sample={SAMPLE_PLAN}
          label="Loading plan"
          error={failed || undefined}
        >
          {(state) =>
            state.enabled ? (
              <PlanGroup billing={state} />
            ) : (
              <SettingsGroup>
                <SettingsEmptyState
                  title="No billing on this install"
                  description="Every workspace here is unlimited."
                />
              </SettingsGroup>
            )
          }
        </Skeleton>
      </SettingsSection>

      {/* Only a plan in good standing has an allowance to count against. */}
      {(data === undefined || triage) && (
        <SettingsSection
          title="AI triage"
          info="Each email the AI sorts counts once. Past the allowance, new mail waits untriaged until the reset; everything else keeps working."
        >
          <Skeleton
            id="settings-billing-triage"
            data={triage}
            sample={SAMPLE_TRIAGE}
            label="Loading usage"
          >
            {(usage) => <TriageGroup triage={usage} />}
          </Skeleton>
        </SettingsSection>
      )}
    </SettingsSections>
  );
}

function PlanGroup({ billing }: { billing: EnabledBilling }) {
  const { subscription, readOnly, canManage } = billing;
  const status = subscription ? (STATUS[subscription.status] ?? NO_PLAN) : NO_PLAN;
  const date = subscription && planDate(subscription);
  const pastDue = subscription?.status === "past_due";
  const statusNote = readOnly
    ? canManage
      ? "Read-only: mail keeps syncing, nothing is sent"
      : "Read-only until an owner or admin subscribes"
    : pastDue
      ? "The last payment failed; Stripe is retrying it"
      : undefined;

  return (
    <SettingsGroup>
      <SettingsRow
        label="Status"
        description={statusNote}
        className={settingsRowTextEndClassName}
        control={<Badge intent={status.intent}>{status.label}</Badge>}
      />
      {!readOnly && subscription?.interval && (
        <SettingsValueRow
          label="Billing"
          value={INTERVAL_LABELS[subscription.interval as Interval] ?? subscription.interval}
        />
      )}
      {date && <SettingsValueRow label={date.label} value={date.value} />}
      {canManage && readOnly && <SubscribeRow billing={billing} />}
      {/* The portal needs the workspace's Stripe customer, which its first checkout made. */}
      {canManage && subscription && <PortalRow primary={pastDue} />}
    </SettingsGroup>
  );
}

/** Starts Checkout: the trial for a workspace that never had a plan, else the plan itself. */
function SubscribeRow({ billing }: { billing: EnabledBilling }) {
  const checkout = useStartCheckout();
  const [choosing, setChoosing] = useState(false);
  const trial = billing.trialDays > 0 && !billing.subscription;
  const action = trial ? "Start trial" : "Subscribe";
  // Pending until the browser has left for Stripe, not just until the URL came back.
  const leaving = checkout.isPending || checkout.isSuccess;
  const start = (interval: Interval) =>
    checkout.mutate(interval, {
      onError: (error) => appToast.error(error.message || "Checkout could not be opened."),
    });

  return (
    <>
      <SettingsButtonRow
        label={
          trial
            ? `Start a ${billing.trialDays}-day trial`
            : billing.subscription
              ? "Subscribe again"
              : "Start the plan"
        }
        description={
          trial
            ? "No card needed"
            : billing.subscription
              ? "Turns sending and AI triage back on"
              : "Turns on sending and AI triage"
        }
        actionLabel={action}
        tone="primary"
        loading={leaving && !choosing}
        onAction={() =>
          billing.intervals.length > 1 ? setChoosing(true) : start(billing.intervals[0])
        }
      />
      {choosing && (
        <IntervalDialog
          title={trial ? `Start a ${billing.trialDays}-day trial` : "Subscribe"}
          intervals={billing.intervals}
          saving={leaving}
          onClose={() => setChoosing(false)}
          onContinue={start}
        />
      )}
    </>
  );
}

/** Monthly or yearly, before Checkout; prices and promo codes are on Stripe's page. */
function IntervalDialog(props: {
  title: string;
  intervals: readonly Interval[];
  saving: boolean;
  onClose: () => void;
  onContinue: (interval: Interval) => void;
}) {
  const [interval, setInterval] = useState<Interval>(props.intervals[0] ?? "month");
  const options = props.intervals.map((value) => ({ id: value, label: INTERVAL_LABELS[value] }));
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={props.title}
      description="Prices and promo codes are shown at checkout."
      action="Continue to checkout"
      saving={props.saving}
      onSubmit={() => props.onContinue(interval)}
    >
      <Select
        value={interval}
        onChange={(next) => {
          const option = props.intervals.find((value) => value === next);
          if (option) setInterval(option);
        }}
      >
        <Label>Billing</Label>
        <SelectTrigger />
        <SelectContent items={options}>
          {(option) => (
            <SelectItem id={option.id} textValue={option.label}>
              {option.label}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </SettingsFormDialog>
  );
}

/** The Stripe customer portal: card, invoices, interval, cancellation. */
function PortalRow({ primary }: { primary: boolean }) {
  const portal = useOpenBillingPortal();
  return (
    <SettingsButtonRow
      label="Payment and invoices"
      description="Card, invoices, billing interval and cancellation"
      actionLabel={primary ? "Update payment" : "Manage"}
      tone={primary ? "primary" : "secondary"}
      loading={portal.isPending || portal.isSuccess}
      onAction={() =>
        portal.mutate(undefined, {
          onError: (error) => appToast.error(error.message || "The portal could not be opened."),
        })
      }
    />
  );
}

function TriageGroup({ triage }: { triage: Triage }) {
  const paused = triage.pausedUntil !== null;
  return (
    <SettingsGroup>
      <SettingsMeterRow
        label="Emails triaged"
        amount={`${NUMBER.format(triage.used)} of ${NUMBER.format(triage.allowance)}`}
        value={triage.used}
        max={triage.allowance}
        warn={triage.used >= triage.allowance * 0.9}
      />
      <SettingsValueRow
        label={paused ? "Paused until" : "Resets"}
        value={day(triage.pausedUntil ?? triage.periodEnd)}
        tone={paused ? "danger" : "default"}
      />
    </SettingsGroup>
  );
}
