import type { Key } from "react-aria-components";
import { ChoiceBox, ChoiceBoxItem } from "@/components/ui/choice-box";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { useBilling } from "@/hooks/use-billing.ts";
import { type Interval, type PlanChoice, type PlanKey, planOption } from "@/lib/billing.ts";

type Offered = Extract<
  NonNullable<ReturnType<typeof useBilling>["data"]>,
  { enabled: true }
>["plans"][number];

const LIMITS = {
  team: {
    members: 15,
    mailboxes: 30,
    domains: 5,
    storageGb: 100,
    triage: 20_000,
    assist: 250,
    meetingMinutes: 900,
  },
  business: {
    members: 75,
    mailboxes: 150,
    domains: 20,
    storageGb: 500,
    triage: 75_000,
    assist: 1_000,
    meetingMinutes: 6000,
  },
};

/** Stand-in plans for a skeleton while the real ones load. */
export const SAMPLE_PLANS: Offered[] = [
  {
    key: "team",
    name: "Omni Team",
    intervals: ["month", "year"],
    limits: LIMITS.team,
    prices: { month: { amount: 2500, currency: "usd" }, year: { amount: 25000, currency: "usd" } },
  },
  {
    key: "business",
    name: "Omni Business",
    intervals: ["month", "year"],
    limits: LIMITS.business,
    prices: { month: { amount: 6000, currency: "usd" }, year: { amount: 60000, currency: "usd" } },
  },
];

const INTERVALS: { id: Interval; label: string }[] = [
  { id: "month", label: "Monthly" },
  { id: "year", label: "Yearly" },
];

/**
 * Picks a plan and how often it is billed: Monthly or Yearly over one card per plan, each with its
 * price and what it holds. `current` marks the workspace's own plan at its own interval.
 */
export function PlanPicker(props: {
  plans: readonly Offered[];
  value: PlanChoice;
  onChange: (next: PlanChoice) => void;
  current?: PlanChoice | null;
}) {
  const { plans, value, onChange, current } = props;
  const yearly = plans.some((plan) => (plan.intervals as readonly Interval[]).includes("year"));
  const offered = plans.filter((plan) =>
    (plan.intervals as readonly Interval[]).includes(value.interval),
  );
  const items = offered.map((plan) => {
    const option = planOption(plan, value.interval);
    const isCurrent = current?.plan === plan.key && current.interval === value.interval;
    return {
      id: option.id,
      label: isCurrent ? `${option.label} · Current` : option.label,
      description: [option.price, option.holds].filter(Boolean).join(" · "),
    };
  });

  return (
    <div className="flex flex-col gap-3">
      {yearly && (
        <ToggleGroup
          aria-label="Billing"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[value.interval]}
          onSelectionChange={(keys) => {
            const [next] = [...keys];
            if (next !== "month" && next !== "year") return;
            const sold = plans.filter((plan) =>
              (plan.intervals as readonly Interval[]).includes(next),
            );
            const stays = sold.some((plan) => plan.key === value.plan);
            onChange({ plan: stays ? value.plan : (sold[0]?.key ?? value.plan), interval: next });
          }}
        >
          {INTERVALS.map((option) => (
            <ToggleGroupItem key={option.id} id={option.id}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <ChoiceBox
        aria-label="Plan"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[value.plan]}
        onSelectionChange={(keys) => {
          const [key] = [...(keys as Set<Key>)];
          if (key === "team" || key === "business") {
            onChange({ plan: key satisfies PlanKey, interval: value.interval });
          }
        }}
        items={items}
      >
        {(item) => <ChoiceBoxItem id={item.id} label={item.label} description={item.description} />}
      </ChoiceBox>
    </div>
  );
}
