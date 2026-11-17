// The workspace's CRM settings: today, the default currency.
import { eq } from "drizzle-orm";
import { crmSettings } from "../schema/crm.ts";
import { isCurrency, type CrmMember, type Ex } from "./core.ts";
import { ensureCrm } from "./stages.ts";

export interface CrmSettings {
  /** ISO 4217; the last currency the workspace used. Null until one is used or set. */
  defaultCurrency: string | null;
}

export async function getSettings(ex: Ex, member: CrmMember) {
  await ensureCrm(ex, member.orgId);
  const [row] = await ex
    .select({ defaultCurrency: crmSettings.defaultCurrency })
    .from(crmSettings)
    .where(eq(crmSettings.orgId, member.orgId));
  return { status: "ok" as const, settings: { defaultCurrency: row?.defaultCurrency ?? null } };
}

export const putSettings: (
  tx: Ex,
  member: CrmMember,
  input: { defaultCurrency: string | null },
) => Promise<{ status: "ok"; settings: CrmSettings } | { status: "invalid_currency" }> = async (
  tx,
  member,
  input,
) => {
  if (input.defaultCurrency !== null && !isCurrency(input.defaultCurrency)) {
    return { status: "invalid_currency" };
  }
  await ensureCrm(tx, member.orgId);
  await tx
    .update(crmSettings)
    .set({ defaultCurrency: input.defaultCurrency })
    .where(eq(crmSettings.orgId, member.orgId));
  return { status: "ok", settings: { defaultCurrency: input.defaultCurrency } };
};
