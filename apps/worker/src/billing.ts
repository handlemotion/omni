// Billing as the rest of the Worker sees it (ADR 0015). With billing off (no STRIPE_SECRET_KEY)
// every workspace is unlimited and writable, exactly as before billing existed.
import { usagePeriod } from "@omni/ai";
import {
  claimTriage,
  isPaid,
  triageUsageCount,
  workspaceSubscription,
  type Db,
  type WorkspaceSubscription,
} from "@omni/db";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";
import type { Config } from "./env.ts";

export type WorkspaceBilling =
  | { enabled: false }
  | {
      enabled: true;
      subscription: WorkspaceSubscription;
      /** No subscription in good standing: mail syncs and reads, nothing is written or triaged. */
      readOnly: boolean;
      /** This usage month's AI triage, when the workspace has a subscription to count against. */
      triage: {
        used: number;
        allowance: number;
        periodStart: Date;
        periodEnd: Date;
        /** Allowance used up: new mail is not AI-triaged until `periodEnd`. */
        paused: boolean;
      } | null;
    };

function period(subscription: WorkspaceSubscription, now: Date) {
  if (!subscription?.periodStart) return null;
  return usagePeriod(
    {
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      interval: subscription.billingInterval,
    },
    now,
  );
}

export async function workspaceBilling(
  db: Db,
  config: Config,
  orgId: string,
  now = new Date(),
): Promise<WorkspaceBilling> {
  const billing = config.auth.billing;
  if (!billing) return { enabled: false };
  const subscription = await workspaceSubscription(db, orgId);
  const paid = subscription !== null && isPaid(subscription.status);
  const window = paid ? period(subscription, now) : null;
  const used = window ? await triageUsageCount(db, orgId, window.start) : 0;
  return {
    enabled: true,
    subscription,
    readOnly: !paid,
    triage: window
      ? {
          used,
          allowance: billing.triageAllowance,
          periodStart: window.start,
          periodEnd: window.end,
          paused: used >= billing.triageAllowance,
        }
      : null,
  };
}

export type TriageGate =
  | { run: true }
  | { run: false; reason: "billing_inactive" }
  | { run: false; reason: "allowance_reached"; until: Date };

/**
 * Whether the model may triage `messageId` now, taking one unit of the allowance when it may.
 * Called only when a model would actually run; rule-filed threads cost nothing and never count.
 */
export async function gateTriage(
  db: Db,
  config: Config,
  input: { orgId: string; messageId: string },
  now = new Date(),
): Promise<TriageGate> {
  const billing = config.auth.billing;
  if (!billing) return { run: true };
  const subscription = await workspaceSubscription(db, input.orgId);
  const window = subscription && isPaid(subscription.status) ? period(subscription, now) : null;
  if (!window) return { run: false, reason: "billing_inactive" };
  const claim = await claimTriage(db, {
    orgId: input.orgId,
    periodStart: window.start,
    messageId: input.messageId,
    allowance: billing.triageAllowance,
  });
  return claim === "over"
    ? { run: false, reason: "allowance_reached", until: window.end }
    : { run: true };
}

/** A subscription in good standing (or billing off): the workspace may write and use AI. */
export async function inGoodStanding(db: Db, config: Config, orgId: string) {
  if (!config.auth.billing) return true;
  const subscription = await workspaceSubscription(db, orgId);
  return subscription !== null && isPaid(subscription.status);
}

/**
 * Mail writes (send, reply, archive, read state…) need a workspace in good standing. Reads pass,
 * so a read-only workspace keeps its mail visible and syncing.
 */
export const requireWritableWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.var.config.auth.billing) {
    if (!(await inGoodStanding(c.var.db, c.var.config, c.var.member.orgId))) {
      return c.json(
        {
          error: "this workspace is read-only until it has an active plan",
          code: "BILLING_INACTIVE",
        },
        402,
      );
    }
  }
  await next();
});

export function requireBilling(config: Config) {
  const billing = config.auth.billing;
  if (!billing) throw new HTTPException(404, { message: "billing is not enabled" });
  return billing;
}
