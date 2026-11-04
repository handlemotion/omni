// Placeholder UI: the workspace's plan and this period's AI triage usage (ADR 0015). There is no
// Figma frame for billing yet, so this stays bare like the other settings pages; the hooks are
// the real part.
import { createFileRoute } from "@tanstack/react-router";
import {
  useBilling,
  useOpenBillingPortal,
  useStartCheckout,
} from "../../../../hooks/use-billing.ts";
import { billingQuery } from "../../../../lib/billing.ts";

export const Route = createFileRoute("/_authed/_member/settings/billing")({
  loader: ({ context }) => context.queryClient.ensureQueryData(billingQuery()),
  component: Billing,
});

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

function Billing() {
  const billing = useBilling();
  const checkout = useStartCheckout();
  const portal = useOpenBillingPortal();
  const data = billing.data;
  if (!data) return null; // The route loader fetched it.
  if (!data.enabled) return <main>Billing is off on this install: no plan, no limits.</main>;

  const { subscription, triage } = data;
  return (
    <main>
      <h2>Plan</h2>
      <p>
        {subscription
          ? `${subscription.status}${subscription.interval ? `, billed ${subscription.interval}ly` : ""}`
          : "No plan yet"}
        {subscription?.trialEnd && subscription.status === "trialing"
          ? ` · trial ends ${day(subscription.trialEnd)}`
          : ""}
        {subscription?.cancelAtPeriodEnd && subscription.periodEnd
          ? ` · ends ${day(subscription.periodEnd)}`
          : ""}
      </p>
      {data.readOnly && <p>This workspace is read-only: mail keeps syncing, nothing is sent.</p>}

      <h2>AI triage this period</h2>
      {triage ? (
        <p>
          <span className="tabular-nums">
            {triage.used} / {triage.allowance}
          </span>{" "}
          emails · resets {day(triage.periodEnd)}
          {triage.pausedUntil && ` · AI triage paused until ${day(triage.pausedUntil)}`}
        </p>
      ) : (
        <p>None without a plan.</p>
      )}

      {data.canManage &&
        (data.readOnly ? (
          data.intervals.map((interval) => (
            <button key={interval} type="button" onClick={() => checkout.mutate(interval)}>
              {data.trialDays > 0 && !subscription
                ? `Start ${data.trialDays}-day trial`
                : "Subscribe"}{" "}
              ({interval}ly)
            </button>
          ))
        ) : (
          <button type="button" onClick={() => portal.mutate()}>
            Manage plan
          </button>
        ))}
      {(checkout.error ?? portal.error) && <p>{(checkout.error ?? portal.error)?.message}</p>}
    </main>
  );
}
