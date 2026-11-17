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
import { apiError } from "./errors.ts";

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

/** The usage month `now` falls in, for triage and for Storage's peak; null with no period yet. */
export function period(subscription: WorkspaceSubscription, now: Date) {
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

export const workspaceBilling: (
  db: Db,
  config: Config,
  orgId: string,
  now?: Date,
) => Promise<WorkspaceBilling> = async (db, config, orgId, now = new Date()) => {
  const billing = config.auth.billing;
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
};

export type TriageGate =
  | { run: true }
  | { run: false; reason: "billing_inactive" }
  | { run: false; reason: "allowance_reached"; until: Date };

/**
 * Whether the model may triage `messageId` now, taking one unit of the allowance when it may.
 * Called only when a model would actually run; rule-filed threads cost nothing and never count.
 */
export const gateTriage: (
  db: Db,
  config: Config,
  input: { orgId: string; messageId: string },
  now?: Date,
) => Promise<TriageGate> = async (db, config, input, now = new Date()) => {
  const billing = config.auth.billing;
  if (!billing) return { run: true };
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
};

/** A subscription in good standing (or billing off): the workspace may write and use AI. */
export async function inGoodStanding(db: Db, config: Config, orgId: string) {
  if (!config.auth.billing) return true;
  if ((await workspaceKind(db, orgId)) === "personal") return true;
  const subscription = await workspaceSubscription(db, orgId);
  return subscription !== null && isPaid(subscription.status);
}

/** What a write in a workspace without a plan in good standing is told (`billing_inactive`). */
export const READ_ONLY_MESSAGE = "this workspace is read-only until it has an active plan";

export const READ_ONLY_ALLOWED = [
  { path: "/api/billing", reason: "checkout and the portal are how a workspace becomes paid" },
  { path: "/api/workspace/members", reason: "giving a member an inbox is setup, not mail" },
  { path: "/api/workspace/shared-inboxes", reason: "who can see a mailbox is access, not mail" },
  { path: "/api/workspace/inboxes", reason: "who owns a former member's inbox is access" },
  { path: "/api/workspace/invitations", reason: "invitations stay open so an owner can fix it" },
  {
    path: "/api/push-tokens",
    reason: "a person's phone, not the workspace: signing out must stop pushes",
  },
  { path: "/api/auth", reason: "sign-in, invitations, organizations and Stripe's webhook" },
  { path: "/api/onboarding", reason: "workspace setup: domains and mailboxes" },
  { path: "/api/workspaces", reason: "which workspaces the user belongs to" },
  { path: "/api/join", reason: "asking to join a company, and the answer: membership, not mail" },
  { path: "/api/account", reason: "the person's own sign-in emails, not the workspace" },
  {
    path: "/api/storage/shared",
    reason: "gated in storage/shared.ts by the shared node's workspace, not the visitor's own",
  },
  {
    path: "/api/oauth",
    reason: "an agent's sign-in and its workspace choice: access, not mail (ADR 0029)",
  },
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
      return apiError(c, "billing_inactive", READ_ONLY_MESSAGE);
    }
  }
  await next();
});

export function requireBilling(config: Config) {
  const billing = config.auth.billing;
  if (!billing) throw new HTTPException(404, { message: "billing is not enabled" });
  return billing;
}
