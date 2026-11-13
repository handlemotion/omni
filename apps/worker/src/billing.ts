// Billing as the rest of the Worker sees it (ADR 0015). With billing off (no STRIPE_SECRET_KEY)
// every workspace is unlimited and writable, exactly as before billing existed.
import { usagePeriod } from "@omni/ai";
import {
  claimTriage,
  isPaid,
  triageUsageCount,
  workspaceKind,
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
  // A Personal space is free (ADR 0024): billing does not apply to it.
  if (!billing || (await workspaceKind(db, orgId)) === "personal") return { enabled: false };
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
  // A Personal space is free and keeps AI triage, with no plan and no allowance (ADR 0024).
  if ((await workspaceKind(db, input.orgId)) === "personal") return { run: true };
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
  // A Personal space is free (ADR 0024).
  if ((await workspaceKind(db, orgId)) === "personal") return true;
  const subscription = await workspaceSubscription(db, orgId);
  return subscription !== null && isPaid(subscription.status);
}

/**
 * The writes under `/api` an unpaid workspace may still make (ADR 0015: "setup, members,
 * invitations and billing stay open so an owner can always fix it"). Everything else is denied.
 * A path matches an entry when it is the entry or below it; `:param` matches one segment.
 * `e2e/billing-gate.e2e.test.ts` sends every write route in `app` and holds this list to it.
 */
export const READ_ONLY_ALLOWED = [
  // Inside the member API: `requireWritableWorkspace` lets these through.
  { path: "/api/billing", reason: "checkout and the portal are how a workspace becomes paid" },
  // The workspace inbox API (ADR 0026): who has which inbox, and inviting people with one.
  { path: "/api/workspace/members", reason: "giving a member an inbox is setup, not mail" },
  { path: "/api/workspace/shared-inboxes", reason: "who can see a mailbox is access, not mail" },
  { path: "/api/workspace/inboxes", reason: "who owns a former member's inbox is access" },
  { path: "/api/workspace/invitations", reason: "invitations stay open so an owner can fix it" },
  {
    path: "/api/push-tokens",
    reason: "a person's phone, not the workspace: signing out must stop pushes",
  },
  // Mounted ahead of the member API in app.ts, so the gate never runs for them.
  { path: "/api/auth", reason: "sign-in, invitations, organizations and Stripe's webhook" },
  { path: "/api/onboarding", reason: "workspace setup: domains and mailboxes" },
  { path: "/api/workspaces", reason: "which workspaces the user belongs to" },
  { path: "/api/join", reason: "asking to join a company, and the answer: membership, not mail" },
  { path: "/api/account", reason: "the person's own sign-in emails, not the workspace" },
] as const satisfies readonly { path: string; reason: string }[];

export function allowedWhileReadOnly(path: string) {
  const segments = path.split("/");
  return READ_ONLY_ALLOWED.some((entry) => {
    const pattern = entry.path.split("/");
    return (
      segments.length >= pattern.length &&
      pattern.every((part, i) => part.startsWith(":") || part === segments[i])
    );
  });
}

/**
 * Every write under the member API needs a workspace in good standing unless `READ_ONLY_ALLOWED`
 * names it. Reads pass, so a read-only workspace keeps its mail visible and syncing.
 */
export const requireWritableWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  if (
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    c.var.config.auth.billing &&
    !allowedWhileReadOnly(c.req.path)
  ) {
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
