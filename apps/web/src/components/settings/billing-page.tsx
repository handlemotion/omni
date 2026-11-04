// The active workspace's plan (ADR 0015): one plan card at the top (name, price, where it
// stands, and the one thing to do about it), this month's AI triage against the allowance, then
// the saved cards and the invoices: for owners and admins (transitive's payment details, read from
// Stripe through `/api/billing/cards` and `/api/billing/invoices`); members see those two sections
// say they're for owners and admins. A workspace always has a plan
// (setup starts its trial), so there is no "no plan" page; one that ended can subscribe again.
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  TrashIcon,
} from "@heroicons/react/16/solid";
import { cn } from "cn";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import { CardBrandMark } from "@/components/icons/card-brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { appToast } from "@/components/ui/toast";
import {
  useBilling,
  useBillingCards,
  useBillingInvoices,
  useMakeDefaultCard,
  useOpenBillingPortal,
  useRemoveCard,
  useStartCheckout,
} from "@/hooks/use-billing.ts";
import { type Card, type Cards, formatPrice, type Invoice } from "@/lib/billing.ts";
import { BillingAddCardDialog } from "./billing-add-card-dialog";
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
import { SettingsConfirmDialog, SettingsFormDialog } from "./kit/settings-stacked-dialog";
import { SettingsValueRow } from "./kit/settings-value-row";

type Billing = NonNullable<ReturnType<typeof useBilling>["data"]>;
type EnabledBilling = Extract<Billing, { enabled: true }>;
type Subscription = NonNullable<EnabledBilling["subscription"]>;
type Triage = NonNullable<EnabledBilling["triage"]>;
type Interval = EnabledBilling["intervals"][number];

/** Where Stripe's Checkout and portal send people back: this page. */
const RETURN_PATH = "/settings/billing";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const NUMBER = new Intl.NumberFormat();
const day = (iso: string) => DAY.format(new Date(iso));
const shortDay = (iso: string) => SHORT_DAY.format(new Date(iso));

// Skeleton stand-ins: an active monthly plan part way through its month, two cards, two invoices.
const SAMPLE_PLAN: Billing = {
  enabled: true,
  readOnly: false,
  canManage: true,
  intervals: ["month"],
  planName: "Omnipresent",
  prices: { month: { amount: 1900, currency: "usd" }, year: null },
  trialDays: 0,
  trialAvailable: false,
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
const SAMPLE_CARDS: Cards = {
  addCard: true,
  cards: [
    { id: "pm_1", brand: "visa", last4: "4242", expMonth: 4, expYear: 2030, isDefault: true },
    {
      id: "pm_2",
      brand: "mastercard",
      last4: "4444",
      expMonth: 9,
      expYear: 2028,
      isDefault: false,
    },
  ],
};
const SAMPLE_INVOICES: Invoice[] = ["2026-11-04", "2026-10-04"].map((date, index) => ({
  id: `in_${index}`,
  number: `OMNI-000${2 - index}`,
  createdAt: `${date}T00:00:00.000Z`,
  total: 1900,
  currency: "usd",
  status: "paid",
  url: null,
  pdfUrl: null,
}));

const INTERVAL_LABELS: Record<Interval, string> = { month: "Monthly", year: "Yearly" };

type Intent = "success" | "info" | "warning" | "danger" | "secondary";

/**
 * Where the plan stands, in the card's own words: a badge only when it is not simply running,
 * and the one date that matters now.
 */
function planState(subscription: Subscription | null): {
  badge?: { label: string; intent: Intent };
  date?: string;
} {
  if (!subscription) return { badge: { label: "No plan", intent: "secondary" } };
  const { status, periodEnd, trialEnd, cancelAtPeriodEnd } = subscription;
  const end = (status === "trialing" ? (trialEnd ?? periodEnd) : periodEnd) ?? null;
  if (status === "trialing") {
    return {
      badge: { label: "Trial", intent: "info" },
      date: end ? `${cancelAtPeriodEnd ? "Ends" : "Trial ends"} ${shortDay(end)}` : undefined,
    };
  }
  if (status === "active") {
    return cancelAtPeriodEnd
      ? {
          badge: { label: "Ending", intent: "secondary" },
          date: end ? `Ends ${shortDay(end)}` : undefined,
        }
      : { date: end ? `Renews ${shortDay(end)}` : undefined };
  }
  if (status === "past_due") {
    return { badge: { label: "Past due", intent: "warning" }, date: "Stripe is retrying the card" };
  }
  if (status === "unpaid") return { badge: { label: "Unpaid", intent: "danger" } };
  if (status === "incomplete") return { badge: { label: "Incomplete", intent: "warning" } };
  return {
    badge: { label: "Ended", intent: "secondary" },
    date: end ? `Ended ${shortDay(end)}` : undefined,
  };
}

export function BillingPage() {
  const billing = useBilling();
  const data = billing.data;
  const enabled = data?.enabled ? data : undefined;
  const triage = enabled?.triage;
  // Cards and invoices are Stripe's, shown to the people who manage billing.
  const manager = data === undefined || enabled?.canManage === true;
  const failed = billing.isError && (
    <SettingsEmptyState title="Billing didn't load" description="Try again in a moment." />
  );

  return (
    <SettingsSections>
      <Skeleton
        id="settings-billing-plan"
        data={data}
        sample={SAMPLE_PLAN}
        label="Loading plan"
        error={failed || undefined}
      >
        {(state) =>
          state.enabled ? (
            <PlanCard billing={state} />
          ) : (
            <SettingsEmptyState
              title="No billing on this install"
              description="Every workspace here is unlimited."
            />
          )
        }
      </Skeleton>

      {(data === undefined || enabled) && (
        <SettingsSection
          title="AI triage"
          info="Each email the AI sorts counts once. Past the allowance, new mail waits untriaged until the reset; everything else keeps working."
        >
          {/* Only a plan in good standing has an allowance to count against. */}
          <Skeleton
            id="settings-billing-triage"
            // Wrapped: skullet reads a bare null as "not loaded yet".
            data={enabled ? { usage: triage ?? null } : undefined}
            sample={{ usage: SAMPLE_TRIAGE }}
            label="Loading usage"
          >
            {({ usage }) =>
              usage ? (
                <TriageGroup triage={usage} />
              ) : (
                <SettingsEmptyState
                  title="No allowance right now"
                  description="AI triage counts against a plan in good standing."
                />
              )
            }
          </Skeleton>
        </SettingsSection>
      )}

      {(data === undefined || enabled) &&
        (manager ? (
          <>
            <CardsSection billing={enabled} />
            <InvoicesSection ready={enabled !== undefined} />
          </>
        ) : (
          // Stripe's cards and invoices are for owners and admins: the sections stay, saying so,
          // and their routes (403 for members) are never called.
          <>
            <SettingsSection title="Payment methods">
              <SettingsEmptyState
                variant="restricted"
                title="Only owners and admins see payment methods"
                description="Ask one of them to add or change the card the plan is paid with."
              />
            </SettingsSection>
            <SettingsSection title="Invoices">
              <SettingsEmptyState
                variant="restricted"
                title="Only owners and admins see invoices"
                description="Ask one of them for a receipt."
              />
            </SettingsSection>
          </>
        ))}
    </SettingsSections>
  );
}

/** The plan at a glance: what it is, what it costs, where it stands, and the one action. */
function PlanCard({ billing }: { billing: EnabledBilling }) {
  const { subscription, readOnly, canManage } = billing;
  const state = planState(subscription);
  const interval = subscription?.interval as Interval | null | undefined;
  const price = interval ? billing.prices[interval] : null;
  const pastDue = subscription?.status === "past_due";
  const note = readOnly
    ? canManage
      ? "Read-only: mail keeps syncing, nothing is sent until the plan is back."
      : "Read-only until an owner or admin subscribes again."
    : undefined;
  const line = [price && `${formatPrice(price)} / ${interval}`, state.date].filter(Boolean);

  return (
    <SettingsGroup>
      <div className="flex min-h-21 items-center gap-4 py-4 ps-4 pe-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-lg text-foreground">{billing.planName ?? "Plan"}</h3>
            {state.badge && <Badge intent={state.badge.intent}>{state.badge.label}</Badge>}
          </div>
          {line.length > 0 && (
            <p className="truncate text-sm text-muted-foreground tabular-nums">
              {line.join(" · ")}
            </p>
          )}
        </div>
        {canManage &&
          (readOnly ? <SubscribeButton billing={billing} /> : <PortalButton primary={pastDue} />)}
      </div>
      {note && <p className="px-4 py-3 text-xs/4 text-muted-foreground">{note}</p>}
    </SettingsGroup>
  );
}

/** For a plan that ended: Checkout again (its one trial is spent), monthly or yearly. */
function SubscribeButton({ billing }: { billing: EnabledBilling }) {
  const checkout = useStartCheckout();
  const [choosing, setChoosing] = useState(false);
  // Pending until the browser has left for Stripe, not just until the URL came back.
  const leaving = checkout.isPending || checkout.isSuccess;
  const start = (interval: Interval) =>
    checkout.mutate(
      { interval, returnPath: RETURN_PATH },
      { onError: (error) => appToast.error(error.message || "Checkout could not be opened.") },
    );
  return (
    <>
      <Button
        isPending={leaving && !choosing}
        onPress={() =>
          billing.intervals.length > 1 ? setChoosing(true) : start(billing.intervals[0])
        }
      >
        Subscribe
      </Button>
      {choosing && (
        <IntervalDialog
          billing={billing}
          saving={leaving}
          onClose={() => setChoosing(false)}
          onContinue={start}
        />
      )}
    </>
  );
}

/** Monthly or yearly, at Stripe's prices, before Checkout; promo codes go in on Stripe's page. */
function IntervalDialog(props: {
  billing: EnabledBilling;
  saving: boolean;
  onClose: () => void;
  onContinue: (interval: Interval) => void;
}) {
  const { intervals, prices } = props.billing;
  const [interval, setInterval] = useState<Interval>(intervals[0] ?? "month");
  const options = intervals.map((value) => {
    const price = prices[value];
    return {
      id: value,
      label: price
        ? `${INTERVAL_LABELS[value]} · ${formatPrice(price)} / ${value}`
        : INTERVAL_LABELS[value],
    };
  });
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Subscribe"
      description="Promo codes are entered at checkout."
      action="Continue to checkout"
      saving={props.saving}
      onSubmit={() => props.onContinue(interval)}
    >
      <Select
        value={interval}
        onChange={(next) => {
          const option = intervals.find((value) => value === next);
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

/** Stripe's customer portal: billing interval and cancellation. */
function PortalButton({ primary }: { primary: boolean }) {
  const portal = useOpenBillingPortal();
  return (
    <Button
      intent={primary ? "primary" : "outline"}
      isPending={portal.isPending || portal.isSuccess}
      onPress={() =>
        portal.mutate(RETURN_PATH, {
          onError: (error) => appToast.error(error.message || "The portal could not be opened."),
        })
      }
    >
      Manage plan
    </Button>
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

const BRANDS: Record<string, string> = {
  amex: "American Express",
  cartes_bancaires: "Cartes Bancaires",
  diners: "Diners Club",
  discover: "Discover",
  eftpos_au: "eftpos",
  jcb: "JCB",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  visa: "Visa",
};

/** "Visa •••• 4242". */
const cardLabel = (card: Pick<Card, "brand" | "last4">) =>
  `${BRANDS[card.brand] ?? "Card"} •••• ${card.last4}`;

/** True once the card's expiry month is over. */
function cardExpired(card: Pick<Card, "expMonth" | "expYear">, now = new Date()) {
  const year = now.getFullYear();
  return card.expYear < year || (card.expYear === year && card.expMonth < now.getMonth() + 1);
}

/** "Expires 04/2030", or "Expired 04/2024". */
function cardExpiry(card: Pick<Card, "expMonth" | "expYear">) {
  const date = `${String(card.expMonth).padStart(2, "0")}/${card.expYear}`;
  return cardExpired(card) ? `Expired ${date}` : `Expires ${date}`;
}

function CardsSection({ billing }: { billing: EnabledBilling | undefined }) {
  const cards = useBillingCards({ enabled: billing !== undefined });
  const makeDefault = useMakeDefaultCard();
  const remove = useRemoveCard();
  const portal = useOpenBillingPortal();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Card | null>(null);
  const busy = makeDefault.isPending || remove.isPending;
  // Without a publishable key the card is added on Stripe's portal instead.
  const addCard = (inPage: boolean) =>
    inPage
      ? setAdding(true)
      : portal.mutate(RETURN_PATH, {
          onError: (error) => appToast.error(error.message || "The portal could not be opened."),
        });
  const failed = cards.isError && (
    <SettingsEmptyState title="Cards didn't load" description="Try again in a moment." />
  );

  return (
    <SettingsSection
      title="Payment methods"
      info="Cards are kept by Stripe. Card numbers never reach Omni."
    >
      <Skeleton
        id="settings-billing-cards"
        data={cards.data}
        sample={SAMPLE_CARDS}
        label="Loading cards"
        error={failed || undefined}
      >
        {(state) =>
          state.cards.length === 0 ? (
            <SettingsEmptyState
              title="No saved cards"
              description={
                billing?.subscription?.status === "trialing"
                  ? "Add a card before the trial ends to keep the plan."
                  : "Add a card to pay for the plan."
              }
              action={
                <Button
                  size="xs"
                  intent="outline"
                  isPending={!state.addCard && (portal.isPending || portal.isSuccess)}
                  onPress={() => addCard(state.addCard)}
                >
                  Add card
                </Button>
              }
            />
          ) : (
            <SettingsGroup>
              {state.cards.map((card) => (
                <SettingsRow
                  key={card.id}
                  avatar={<CardBrandMark brand={card.brand} />}
                  label={<span className="tabular-nums">{cardLabel(card)}</span>}
                  hint={card.isDefault ? "default" : undefined}
                  description={
                    <span className={cn("tabular-nums", cardExpired(card) && "text-danger")}>
                      {cardExpiry(card)}
                    </span>
                  }
                  control={
                    <SettingsRowMenu
                      label={`Actions for ${cardLabel(card)}`}
                      disabled={busy}
                      items={[
                        ...(card.isDefault
                          ? []
                          : [
                              {
                                icon: CheckCircleIcon,
                                label: "Make default",
                                onAction: () =>
                                  makeDefault.mutate(card.id, {
                                    onSuccess: () => appToast.success("Default card changed."),
                                    onError: (error) =>
                                      appToast.error(
                                        error.message || "The default card didn't change.",
                                      ),
                                  }),
                              },
                            ]),
                        {
                          icon: TrashIcon,
                          label: "Remove card",
                          danger: true,
                          onAction: () => setRemoving(card),
                        },
                      ]}
                    />
                  }
                />
              ))}
              <SettingsAddRow
                label="Add card"
                disabled={busy}
                loading={!state.addCard && (portal.isPending || portal.isSuccess)}
                onPress={() => addCard(state.addCard)}
              />
            </SettingsGroup>
          )
        }
      </Skeleton>

      {adding && <BillingAddCardDialog onClose={() => setAdding(false)} />}
      <SettingsConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove card?"
        description={`${removing ? cardLabel(removing) : "This card"} is removed from Stripe.${
          removing?.isDefault ? " The plan moves to your next card." : ""
        } Past invoices stay.`}
        action="Remove card"
        saving={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              appToast.success("Card removed.");
              setRemoving(null);
            },
            onError: (error) => {
              appToast.error(error.message || "The card wasn't removed.");
              setRemoving(null);
            },
          })
        }
      />
    </SettingsSection>
  );
}

const INVOICE_STATUS: Partial<Record<Invoice["status"], { label: string; intent: Intent }>> = {
  open: { label: "Due", intent: "warning" },
  uncollectible: { label: "Unpaid", intent: "danger" },
  void: { label: "Void", intent: "secondary" },
};

/** "$19", or "$19.50", from Stripe's smallest unit. */
const amount = (invoice: Pick<Invoice, "total" | "currency">) =>
  formatPrice({ amount: invoice.total, currency: invoice.currency });

const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

function InvoicesSection({ ready }: { ready: boolean }) {
  const invoices = useBillingInvoices({ enabled: ready });
  const failed = invoices.isError && (
    <SettingsEmptyState title="Invoices didn't load" description="Try again in a moment." />
  );
  return (
    <SettingsSection title="Invoices" info="Stripe's invoices for this workspace, newest first.">
      <Skeleton
        id="settings-billing-invoices"
        data={invoices.data?.invoices}
        sample={SAMPLE_INVOICES}
        label="Loading invoices"
        error={failed || undefined}
      >
        {(list) =>
          list.length === 0 ? (
            <SettingsEmptyState
              title="No invoices yet"
              description="Each charge for the plan shows here with its receipt."
            />
          ) : (
            <SettingsGroup>
              {list.map((invoice) => {
                const status = INVOICE_STATUS[invoice.status];
                const items = [
                  ...(invoice.url
                    ? [
                        {
                          icon: ArrowTopRightOnSquareIcon,
                          label: invoice.status === "open" ? "Pay invoice" : "View invoice",
                          onAction: () => open(invoice.url!),
                        },
                      ]
                    : []),
                  ...(invoice.pdfUrl
                    ? [
                        {
                          icon: ArrowDownTrayIcon,
                          label: "Download PDF",
                          onAction: () => open(invoice.pdfUrl!),
                        },
                      ]
                    : []),
                ];
                return (
                  <SettingsRow
                    key={invoice.id}
                    icon={DocumentTextIcon}
                    label={<span className="tabular-nums">{invoice.number ?? "Invoice"}</span>}
                    badge={status && <Badge intent={status.intent}>{status.label}</Badge>}
                    description={
                      <span className="tabular-nums">
                        {day(invoice.createdAt)} · {amount(invoice)}
                      </span>
                    }
                    control={
                      items.length > 0 && (
                        <SettingsRowMenu
                          label={`Actions for invoice ${invoice.number ?? day(invoice.createdAt)}`}
                          items={items}
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
    </SettingsSection>
  );
}
