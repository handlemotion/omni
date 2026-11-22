import { addAiUsage, type Db } from "@omni/db";

/** Adds what one model call spent to the workspace's AI usage for today (UTC). */
export function recordAiUsage(
  db: Db,
  orgId: string,
  usage: { tokensIn: number; tokensOut: number },
) {
  return addAiUsage(db, orgId, new Date().toISOString().slice(0, 10), usage);
}
