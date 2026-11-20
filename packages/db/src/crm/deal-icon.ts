import { eq } from "drizzle-orm";
import { crmDeals } from "../schema/crm.ts";
import { NOT_FOUND, type CrmMember, type Ex } from "./core.ts";
import { loadDeal } from "./records.ts";

/**
 * Points the deal at `iconId` (null for none) under its row lock, and names the icon it replaced,
 * so the caller drops exactly that object even when uploads race.
 */
export async function setDealIcon(tx: Ex, member: CrmMember, id: string, iconId: string | null) {
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  if (deal.iconId !== iconId) {
    await tx.update(crmDeals).set({ iconId }).where(eq(crmDeals.id, id));
  }
  return { status: "ok", deal: { ...deal, iconId }, replaced: deal.iconId } as const;
}
