/**
 * What each plan allows a workspace. One flat price per workspace, never per member: a plan is
 * a size band, and every limit is a hard cap, so a bill never grows past the plan's price
 * (extra storage, opt-in with a card, is the one exception). Prices live in Stripe; with billing
 * off there is no plan and no limit at all.
 */
export const PLAN_KEYS = ["free", "team", "business"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type PaidPlanKey = Exclude<PlanKey, "free">;
export const PAID_PLAN_KEYS = ["team", "business"] as const satisfies readonly PaidPlanKey[];

/** Counted against what the workspace holds now. */
export const CAPS = ["members", "mailboxes", "domains", "crmRecords", "storageGb"] as const;
export type Cap = (typeof CAPS)[number];

/** Counted per usage month, then reset. */
export const METERS = ["triage", "assist", "meetingMinutes"] as const;
export type Meter = (typeof METERS)[number];

export interface PlanLimits {
  /** Members plus invitations still open. */
  members: number;
  /** Inboxes, personal and shared. */
  mailboxes: number;
  /** Custom domains the workspace holds. */
  domains: number;
  /** People, companies and deals, archived ones included. Null: no limit. */
  crmRecords: number | null;
  /** Drive storage included, in GB. */
  storageGb: number;
  /** Emails a model files each month. */
  triage: number;
  /** Drafted replies and asks each month: the expensive model. */
  assist: number;
  /** Minutes of meetings transcribed each month. Zero: meetings need a paid plan. */
  meetingMinutes: number;
}

export const PLAN_LIMITS = {
  free: {
    members: 3,
    mailboxes: 5,
    domains: 1,
    crmRecords: 500,
    storageGb: 5,
    triage: 1_000,
    assist: 25,
    meetingMinutes: 0,
  },
  team: {
    members: 15,
    mailboxes: 30,
    domains: 5,
    crmRecords: null,
    storageGb: 100,
    triage: 20_000,
    assist: 250,
    meetingMinutes: 15 * 60,
  },
  business: {
    members: 75,
    mailboxes: 150,
    domains: 20,
    crmRecords: null,
    storageGb: 500,
    triage: 75_000,
    assist: 1_000,
    meetingMinutes: 100 * 60,
  },
} as const satisfies Record<PlanKey, PlanLimits>;

/** Free workspaces one person may own: a free tier per team, not one per tab. */
export const FREE_WORKSPACES_PER_OWNER = 2;

/** The plan a stored subscription's key names. The first plan was one flat plan: today's Team. */
export function planKeyOf(stored: string | null | undefined) {
  const plan: PaidPlanKey | null =
    stored === "team" || stored === "omnipresent"
      ? "team"
      : stored === "business"
        ? "business"
        : null;
  return plan;
}
