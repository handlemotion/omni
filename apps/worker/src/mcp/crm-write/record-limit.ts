import { CrmRecordLimitError } from "@omni/db";
import { capMax } from "../../billing.ts";
import type { CrmWorkspace } from "../crm.ts";
import type { ToolContext } from "../server.ts";

/**
 * Runs an add with the plan's CRM records as its limit, held inside the add's transaction, and
 * answers a refusal as the tool's error.
 */
export async function withinCrmRecords<T>(
  context: ToolContext,
  workspace: CrmWorkspace,
  write: (max: number | null) => Promise<T>,
) {
  const max = await capMax(context.db, context.config, workspace.orgId, "crmRecords");
  try {
    return await write(max);
  } catch (error) {
    if (!(error instanceof CrmRecordLimitError)) throw error;
    return {
      error: `This workspace's plan holds ${error.max} CRM records; move to a bigger plan for more.`,
    } as const;
  }
}
