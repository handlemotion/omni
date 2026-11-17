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
  minute: mailMinute,
  daily: cleanupExpiredUploads,
};

const storage: Module = {
  name: "storage",
  minute: (env) => Promise.all([abortExpiredStorageUploads(env), sealSignatures(env)]),
  daily: storageDaily,
  memberRemoved: (db, { memberId, byMemberId }) =>
    handOverMemberStorage(db, { memberId, toMemberId: byMemberId }),
  workspaceDeleted: (db, { orgId }) => deleteWorkspaceStorage(db, orgId),
};

const crm: Module = {
  name: "crm",
  daily: crmDaily,
};

export const modules: readonly Module[] = [mail, storage, crm];
