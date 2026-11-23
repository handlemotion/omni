import type { BillingConfig } from "@omni/auth";
import type { Db } from "@omni/db";
import type Stripe from "stripe";
import type { Logger } from "./log.ts";

const STRIPE_REQUEST_INTERVAL_MS = 100;

/**
 * Resolves once the run may send its next Stripe request. Stripe's rate limit is per account, so
 * every request of one daily billing run shares one pacer.
 */
export function stripePacer(intervalMs = STRIPE_REQUEST_INTERVAL_MS) {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    next = Date.now() + intervalMs;
  };
}

export type StripePacer = ReturnType<typeof stripePacer>;

/** One daily billing run: the subscription reconcile, then each module's `billingRun`. */
export interface BillingRun {
  db: Db;
  stripe: Stripe;
  billing: BillingConfig;
  log: Logger;
  pace: StripePacer;
}
