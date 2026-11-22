/**
 * What each plan allows a workspace. One flat price per workspace, never per member: a plan is
 * a size band, and every limit is a hard cap, so a bill never grows past the plan's price
 * (extra storage, opt-in with a card, is the one exception). Prices live in Stripe; with billing
 * off there is no plan and no limit at all.
 */
export const PLAN_KEYS = ["team", "business"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** The plan a free trial runs on, and whose caps a workspace sets up under before it has one. */
export const TRIAL_PLAN = "team" satisfies PlanKey;

/** Counted against what the workspace holds now. */
export const CAPS = ["members", "mailboxes", "domains", "storageGb"] as const;
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
  /** Drive storage included, in GB. */
  storageGb: number;
  /** Emails a model files each month. */
  triage: number;
  /** Drafted replies and asks each month: the expensive model. */
  assist: number;
  /** Minutes of meetings transcribed each month. */
  meetingMinutes: number;
}

export const PLAN_LIMITS = {
  team: {
    members: 15,
    mailboxes: 30,
    domains: 5,
    storageGb: 100,
    triage: 20_000,
    assist: 250,
    meetingMinutes: 15 * 60,
  },
  business: {
    members: 75,
    mailboxes: 150,
    domains: 20,
    storageGb: 500,
    triage: 75_000,
    assist: 1_000,
    meetingMinutes: 100 * 60,
  },
} as const satisfies Record<PlanKey, PlanLimits>;

/** The plan a stored subscription's key names. The first plan was one flat plan: today's Team. */
export function planKeyOf(stored: string | null | undefined) {
  const plan: PlanKey | null =
    stored === "team" || stored === "omnipresent"
      ? "team"
      : stored === "business"
        ? "business"
        : null;
  return plan;
}
