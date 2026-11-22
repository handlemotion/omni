import { IconPlus } from "@/components/icons/central";
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
import { StorageUsageSection } from "@/components/storage/storage-usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appToast } from "@/components/ui/toast";
import { PlanPicker, SAMPLE_PLANS } from "@/components/billing/plan-picker";
import {
  useBilling,
  useBillingCards,
  useBillingInvoices,
  useChangePlan,
  useMakeDefaultCard,
  useOpenBillingPortal,
  useRemoveCard,
  useStartCheckout,
  useStartTrial,
} from "@/hooks/use-billing.ts";
import {
  type Card,
  type Cards,
  formatPrice,
  type Invoice,
  type PlanChoice,
  planOption,
} from "@/lib/billing.ts";
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
type Interval = EnabledBilling["intervals"][number];

const RETURN_PATH = "/settings/billing";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const NUMBER = new Intl.NumberFormat();
const day = (iso: string) => DAY.format(new Date(iso));
const shortDay = (iso: string) => SHORT_DAY.format(new Date(iso));

const SAMPLE_PLAN: Billing = {
  enabled: true,
  plan: "team",
  readOnly: false,
  limits: SAMPLE_PLANS[0]!.limits,
  usage: {
    members: 4,
    mailboxes: 6,
    domains: 1,
    storageGb: 3.2,
    triage: 1_200,
    assist: 12,
    meetingMinutes: 180,
  },
  month: { start: "2026-11-04T00:00:00.000Z", end: "2026-12-04T00:00:00.000Z" },
  plans: SAMPLE_PLANS,
  canManage: true,
  trialDays: 7,
  trialAvailable: false,
  subscription: {
    status: "active",
    interval: "month",
    periodEnd: "2026-12-04T00:00:00.000Z",
    trialEnd: null,
    cancelAtPeriodEnd: false,
  },
  intervals: ["month", "year"],
  planName: "Omni Team",
  prices: SAMPLE_PLANS[0]!.prices,
  triage: null,
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

type Intent = "success" | "info" | "warning" | "danger" | "secondary";

const planState: (subscription: Subscription | null) => {
  badge?: { label: string; intent: Intent };
  date?: string;
} = (subscription) => {
  if (!subscription) return {};
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
};

export function BillingPage() {
  const billing = useBilling();
  const data = billing.data;
  const enabled = data?.enabled ? data : undefined;
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
        <SettingsSection title="Usage">
          <Skeleton
            id="settings-billing-usage"
            data={enabled}
            sample={SAMPLE_PLAN as EnabledBilling}
            label="Loading usage"
          >
            {(state) => <UsageGroup billing={state} />}
          </Skeleton>
        </SettingsSection>
      )}

      {(data === undefined || enabled) && <StorageUsageSection />}

      {(data === undefined || enabled) &&
        (manager ? (
          <>
            <CardsSection billing={enabled} />
            <InvoicesSection ready={enabled !== undefined} />
          </>
        ) : (
          <>
            <SettingsSection title="Payment methods">
              <SettingsEmptyState
                variant="restricted"
                title="Owners and admins only"
                description="Ask one to change the card."
              />
            </SettingsSection>
            <SettingsSection title="Invoices">
              <SettingsEmptyState
                variant="restricted"
                title="Owners and admins only"
                description="Ask one for a receipt."
              />
            </SettingsSection>
          </>
        ))}
    </SettingsSections>
  );
}

type PlanMode = "trial" | "checkout" | "change";

function PlanCard({ billing }: { billing: EnabledBilling }) {
  const { subscription, readOnly, canManage } = billing;
  const state = planState(subscription);
  const interval = subscription?.interval as Interval | null | undefined;
  const current = billing.plans.find((plan) => plan.key === billing.plan);
  const price = interval && current ? current.prices[interval] : null;
  const pastDue = subscription?.status === "past_due";
  const [mode, setMode] = useState<PlanMode | null>(null);
  const line = [price && `${formatPrice(price)} / ${interval}`, state.date].filter(Boolean);

  return (
    <SettingsGroup>
      <div className="flex min-h-21 flex-wrap items-center gap-4 py-4 ps-4 pe-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-lg text-foreground">
              {current ? planOption(current, interval ?? "month").label : "No plan"}
            </h3>
            {state.badge && <Badge intent={state.badge.intent}>{state.badge.label}</Badge>}
          </div>
          {line.length > 0 && (
            <p className="truncate text-sm text-muted-foreground tabular-nums">
              {line.join(" · ")}
            </p>
          )}
        </div>
        {canManage &&
          (readOnly ? (
            <Button onPress={() => setMode(billing.trialAvailable ? "trial" : "checkout")}>
              {billing.trialAvailable ? "Start free trial" : "Subscribe"}
            </Button>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <Button intent="outline" onPress={() => setMode("change")}>
                Change plan
              </Button>
              <PortalButton primary={pastDue} />
            </div>
          ))}
      </div>
      {mode && (
        <PlanDialog
          billing={billing}
          mode={mode}
          current={current && interval ? { plan: current.key, interval } : null}
          onClose={() => setMode(null)}
        />
      )}
    </SettingsGroup>
  );
}

const PLAN_DIALOG: Record<PlanMode, { title: string; action: string }> = {
  trial: { title: "Start free trial", action: "Start free trial" },
  checkout: { title: "Subscribe", action: "Continue to checkout" },
  change: { title: "Change plan", action: "Change plan" },
};

function PlanDialog(props: {
  billing: EnabledBilling;
  mode: PlanMode;
  current: PlanChoice | null;
  onClose: () => void;
}) {
  const { billing, mode, current, onClose } = props;
  const trial = useStartTrial();
  const checkout = useStartCheckout();
  const change = useChangePlan();
  const [choice, setChoice] = useState<PlanChoice>(
    current ?? { plan: billing.plans[0]?.key ?? "team", interval: "month" },
  );
  const fail = (error: Error) => appToast.error(error.message || "The plan didn't change.");
  const saving = trial.isPending || checkout.isPending || checkout.isSuccess || change.isPending;
  const submit = () => {
    if (mode === "trial") {
      trial.mutate(choice, {
        onSuccess: () => {
          appToast.success("Free trial started.");
          onClose();
        },
        onError: fail,
      });
    } else if (mode === "checkout") {
      checkout.mutate({ ...choice, returnPath: RETURN_PATH }, { onError: fail });
    } else {
      change.mutate(choice, {
        onSuccess: (result) => {
          if ("pending" in result && result.pending) {
            appToast.error("The card was declined. The plan stays as it is.");
          } else if (result.changed) {
            appToast.success("Plan changed.");
          }
          onClose();
        },
        onError: fail,
      });
    }
  };
  const same = current?.plan === choice.plan && current.interval === choice.interval;

  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={PLAN_DIALOG[mode].title}
      action={PLAN_DIALOG[mode].action}
      saving={saving}
      disabled={mode === "change" && same}
      onSubmit={submit}
    >
      <PlanPicker plans={billing.plans} value={choice} onChange={setChoice} current={current} />
    </SettingsFormDialog>
  );
}

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
      Manage
    </Button>
  );
}

const count = (used: number, limit: number) => `${NUMBER.format(used)} of ${NUMBER.format(limit)}`;

function UsageGroup({ billing }: { billing: EnabledBilling }) {
  const { usage, limits, month } = billing;
  const rows = [
    { label: "Members", used: usage.members, limit: limits.members },
    { label: "Inboxes", used: usage.mailboxes, limit: limits.mailboxes },
    { label: "Domains", used: usage.domains, limit: limits.domains },
    { label: "Emails triaged", used: usage.triage, limit: limits.triage },
    { label: "Drafts and asks", used: usage.assist, limit: limits.assist },
    {
      label: "Meeting hours",
      used: Math.round((usage.meetingMinutes / 60) * 10) / 10,
      limit: limits.meetingMinutes / 60,
    },
  ];
  return (
    <SettingsGroup>
      {rows.map((row) => (
        <SettingsMeterRow
          key={row.label}
          label={row.label}
          amount={count(row.used, row.limit)}
          value={row.used}
          max={row.limit}
          warn={row.used >= row.limit * 0.9}
        />
      ))}
      {month && <SettingsValueRow label="Resets" value={day(month.end)} />}
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

const cardLabel = (card: Pick<Card, "brand" | "last4">) =>
  `${BRANDS[card.brand] ?? "Card"} •••• ${card.last4}`;

function cardExpired(card: Pick<Card, "expMonth" | "expYear">, now = new Date()) {
  const year = now.getFullYear();
  return card.expYear < year || (card.expYear === year && card.expMonth < now.getMonth() + 1);
}

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
              action={
                <Button
                  size="sm"
                  intent="outline"
                  isPending={!state.addCard && (portal.isPending || portal.isSuccess)}
                  onPress={() => addCard(state.addCard)}
                >
                  <IconPlus data-slot="icon" />
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
