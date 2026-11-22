import type { BillingConfig, ModuleLifecycle } from "@omni/auth";
import {
  deleteWorkspaceStorage,
  handOverMemberStorage,
  releaseCalendarTasks,
  releaseCrmTasks,
  type Db,
} from "@omni/db";
import type Stripe from "stripe";
import { calendarArrived, calendarMinute } from "./calendar/jobs.ts";
import { crmDaily, crmMinute } from "./crm/jobs.ts";
import type { Logger } from "./log.ts";
import { mailMinute } from "./mail/jobs.ts";
import { meetingsMinute } from "./meetings/sweep.ts";
import { notePaymentMethod } from "./storage/billing.ts";
import { abortExpiredStorageUploads, storageDaily } from "./storage/jobs.ts";
import { foldLive, type FoldAuthor, type FoldOutcome } from "./storage/live-fold.ts";
import { sealSignatures } from "./storage/seal.ts";
import { journalStorageDocs } from "./storage/journal.ts";
import { indexStorageTexts } from "./storage/texts.ts";
import { cleanupExpiredUploads } from "./uploads.ts";

export interface Module extends ModuleLifecycle {
  /** Every minute. Safe to run twice, and bounded per run. */
  minute?: (env: Env) => Promise<unknown>;
  /** Once a day. Safe to run twice, and bounded per run. */
  daily?: (env: Env) => Promise<unknown>;
  /** After the Stripe webhook applied `event`. Safe to run twice for one event. */
  stripeEvent?: (db: Db, billing: BillingConfig, event: Stripe.Event) => Promise<unknown>;
  /**
   * Saves a doc's live document that people outside the workspace typed in, for the realtime
   * object's alarm (`docs/spec/live-sharing.md`). Idempotent: nothing unsaved, nothing written.
   */
  foldLive?: (
    env: Env,
    input: {
      orgId: string;
      nodeId: string;
      authors: FoldAuthor[];
      member: { memberId: string; lastSeq: number } | null;
      unrecorded?: { cv: number; through: number } | undefined;
    },
  ) => Promise<FoldOutcome>;
  /**
   * Right after the mail service reported new messages. Best effort, after the answer: a module
   * whose minute job reaches the same work uses this only to be faster.
   */
  mailArrived?: (env: Env, db: Db, messageIds: readonly string[], log: Logger) => Promise<unknown>;
}

const mail: Module = {
  name: "mail",
  minute: mailMinute,
  daily: cleanupExpiredUploads,
};

const storage: Module = {
  name: "storage",
  minute: (env) =>
    Promise.all([
      abortExpiredStorageUploads(env),
      sealSignatures(env),
      indexStorageTexts(env),
      journalStorageDocs(env),
    ]),
  daily: storageDaily,
  stripeEvent: notePaymentMethod,
  foldLive,
  memberRemoved: (db, { memberId, byMemberId }) =>
    handOverMemberStorage(db, { memberId, toMemberId: byMemberId }),
  workspaceDeleted: (db, { orgId }) => deleteWorkspaceStorage(db, orgId),
};

const crm: Module = {
  name: "crm",
  minute: crmMinute,
  daily: crmDaily,
  memberRemoved: (db, { orgId, memberId }) => releaseCrmTasks(db, { orgId, memberId }),
};

const calendar: Module = {
  name: "calendar",
  minute: calendarMinute,
  mailArrived: calendarArrived,
  memberRemoved: (db, { orgId, memberId }) => releaseCalendarTasks(db, { orgId, memberId }),
};

const meetings: Module = {
  name: "meetings",
  minute: meetingsMinute,
};

export const modules: readonly Module[] = [mail, storage, crm, calendar, meetings];
