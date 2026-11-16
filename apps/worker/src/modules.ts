// The modules of the one Worker (ADR 0035 decision 3), and what each runs outside a request: its
// every-minute and daily jobs, and its part when a member leaves or a workspace is deleted.
// `index.ts` walks the jobs for the crons; `context.ts` hands the list to `createAuth`, which runs
// the lifecycle hooks without naming a module. Routes stay chained by hand in `app.ts`, because
// Hono RPC infers `AppType` from the chain.
import type { ModuleLifecycle } from "@omni/auth";
import { deleteWorkspaceStorage, handOverMemberStorage } from "@omni/db";
import { crmDaily } from "./crm/jobs.ts";
import { mailMinute } from "./mail/jobs.ts";
import { abortExpiredStorageUploads, storageDaily } from "./storage/jobs.ts";
import { sealSignatures } from "./storage/seal.ts";
import { cleanupExpiredUploads } from "./uploads.ts";

export interface Module extends ModuleLifecycle {
  /** Every minute. Safe to run twice, and bounded per run. */
  minute?: (env: Env) => Promise<unknown>;
  /** Once a day. Safe to run twice, and bounded per run. */
  daily?: (env: Env) => Promise<unknown>;
}

const mail: Module = {
  name: "mail",
  // The helpdesk's clock and the participant backfill (ADR 0036 decision 4).
  minute: mailMinute,
  // Attachments staged for a send that never went.
  daily: cleanupExpiredUploads,
};

const storage: Module = {
  name: "storage",
  // Uploads nobody completed, and signed documents the last signature left unsealed.
  minute: (env) => Promise.all([abortExpiredStorageUploads(env), sealSignatures(env)]),
  daily: storageDaily,
  // Their My files stay with the company, with whoever removed them (ADR 0034 decision 1).
  memberRemoved: (db, { memberId, byMemberId }) =>
    handOverMemberStorage(db, { memberId, toMemberId: byMemberId }),
  // `storage_nodes` would keep the members from being deleted; the files go with the workspace.
  workspaceDeleted: (db, { orgId }) => deleteWorkspaceStorage(db, orgId),
};

const crm: Module = {
  name: "crm",
  // Signed contracts past their end date end (ADR 0039 decision 4).
  daily: crmDaily,
};

export const modules: readonly Module[] = [mail, storage, crm];
