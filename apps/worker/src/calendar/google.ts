import {
  GOOGLE_CALENDAR_EVENTS_PATH,
  GOOGLE_CALENDAR_LIST_PATH,
  googleCalendarEventsResultSchema,
  googleCalendarListResultSchema,
  type GoogleCalendarEventsResult,
} from "@omni/contracts";
import {
  applyGoogleChanges,
  claimGoogleCalendars,
  finishGoogleFullSync,
  liveGmailMailboxes,
  saveGoogleCalendarList,
  saveGoogleSync,
  type Db,
  type GoogleSyncClaim,
} from "@omni/db";
import {
  readGoogleCalendars,
  readGoogleEvent,
  type GoogleCalendarChange,
} from "@omni/mail-core/calendar";
import type { Config } from "../env.ts";
import type { Logger } from "../log.ts";
import { callMailService } from "../mail-service.ts";

/** How often a Gmail inbox's calendar asks Google what changed. */
export const GOOGLE_SYNC_EVERY_MS = 2 * 60_000;
const NO_ACCESS_RETRY_MS = 10 * 60_000;
const FAILED_RETRY_MS = 5 * 60_000;
const CALENDARS_PER_PASS = 20;
const PAGES_PER_CALENDAR = 8;
const PASS_BUDGET_MS = 25_000;

type Page = Extract<GoogleCalendarEventsResult, { status: "ok" }>;

interface Pass {
  db: Db;
  config: Config;
  log: Logger;
  deadline: number;
}

/**
 * The calendar's Google sync (`docs/spec/calendar.md`, "Google calendars"). Each due Gmail inbox
 * first reads its Google calendar list, adding the calendars it gained and retiring the ones it
 * left; then each due calendar, the inbox's own (the primary) and every other one, asks the mail
 * service for what changed in it since the last pass, and applies it. The first pass of a
 * calendar, and any after Google forgets the sync token, reads all of it and then drops the
 * Google events it no longer has. Returns the calendars that changed.
 */
export async function syncGoogleCalendars(db: Db, config: Config, log: Logger, now = new Date()) {
  if (!config.auth.google) return [];
  const mailboxes = await liveGmailMailboxes(db);
  const claims = await claimGoogleCalendars(db, mailboxes, { now, limit: CALENDARS_PER_PASS });
  const run: Run = {
    pass: { db, config, log, deadline: Date.now() + PASS_BUDGET_MS },
    changed: [],
    grew: new Set(),
    retired: new Set(),
  };
  for (const claim of claims) await visit(run, claim);
  if (run.grew.size > 0 && Date.now() <= run.pass.deadline) {
    const added = await claimGoogleCalendars(
      db,
      mailboxes.filter((m) => run.grew.has(m.id)),
      { now, limit: Math.max(0, CALENDARS_PER_PASS - claims.length) },
    );
    for (const claim of added) await visit(run, claim);
  }
  return run.changed;
}

interface Run {
  pass: Pass;
  changed: { calendarId: string; mailboxId: string }[];
  grew: Set<string>;
  retired: Set<string>;
}

async function visit(run: Run, claim: GoogleSyncClaim) {
  const { pass } = run;
  if (run.retired.has(claim.calendarId)) return;
  if (Date.now() > pass.deadline) {
    await saveGoogleSync(pass.db, claim.calendarId, { ...stateOf(claim), nextSyncAt: new Date() });
    return;
  }
  if (claim.googleId === null) await list(run, claim);
  try {
    if (await syncOne(pass, claim)) {
      run.changed.push({ calendarId: claim.calendarId, mailboxId: claim.mailboxId });
    }
  } catch (error) {
    pass.log.warn("calendar.google_failed", { calendarId: claim.calendarId, error });
    await saveGoogleSync(pass.db, claim.calendarId, {
      ...stateOf(claim),
      nextSyncAt: new Date(Date.now() + FAILED_RETRY_MS),
    });
  }
}

async function list(run: Run, claim: GoogleSyncClaim) {
  const listed = await refreshList(run.pass, claim);
  if (listed.added > 0) run.grew.add(claim.mailboxId);
  for (const calendarId of listed.retired) run.retired.add(calendarId);
  if (listed.added > 0 || listed.retired.length > 0 || listed.updated) {
    run.changed.push(
      { calendarId: claim.calendarId, mailboxId: claim.mailboxId },
      ...listed.retired.map((calendarId) => ({ calendarId, mailboxId: claim.mailboxId })),
    );
  }
}

const UNLISTED = { added: 0, retired: [] as string[], updated: false };

async function refreshList(pass: Pass, claim: GoogleSyncClaim) {
  try {
    const answer = await callMailService(
      { config: pass.config, requestId: crypto.randomUUID(), log: pass.log },
      GOOGLE_CALENDAR_LIST_PATH,
      { orgId: claim.orgId, mailboxId: claim.mailboxId },
      googleCalendarListResultSchema,
    );
    if (answer.status !== "ok") return UNLISTED;
    return await saveGoogleCalendarList(
      pass.db,
      { id: claim.mailboxId, orgId: claim.orgId },
      readGoogleCalendars(answer.items),
    );
  } catch (error) {
    pass.log.warn("calendar.google_list_failed", { mailboxId: claim.mailboxId, error });
    return UNLISTED;
  }
}

const stateOf = (claim: GoogleSyncClaim) => ({
  syncToken: claim.syncToken,
  pageToken: claim.pageToken,
  fullSyncStartedAt: claim.fullSyncStartedAt,
  waiting: claim.waiting,
  state: "ok" as const,
});

async function syncOne(pass: Pass, claim: GoogleSyncClaim) {
  const { db, log } = pass;
  const calendar = { id: claim.calendarId, orgId: claim.orgId };
  let state = stateOf(claim);
  if (!state.syncToken && !state.pageToken) state.fullSyncStartedAt ??= new Date();
  let changed = 0;
  for (let pageCount = 0; pageCount < PAGES_PER_CALENDAR; pageCount++) {
    const answer = await fetchPage(pass, claim, state);
    if (answer.status === "no_access") {
      log.info("calendar.google_no_access", {
        calendarId: claim.calendarId,
        reason: answer.reason,
      });
      await saveGoogleSync(db, claim.calendarId, {
        ...state,
        state: "no_access",
        nextSyncAt: new Date(Date.now() + NO_ACCESS_RETRY_MS),
      });
      return changed > 0;
    }
    if (answer.status === "reset") {
      state = {
        syncToken: null,
        pageToken: null,
        fullSyncStartedAt: new Date(),
        waiting: [],
        state: "ok",
      };
      continue;
    }
    const applied = await applyGoogleChanges(db, calendar, [
      ...changesOf(answer),
      ...state.waiting,
    ]);
    changed += applied.changed;
    state = { ...state, waiting: applied.waiting };
    if (answer.nextPageToken) {
      state = { ...state, pageToken: answer.nextPageToken };
      if (Date.now() > pass.deadline) break;
      continue;
    }
    if (state.fullSyncStartedAt) {
      changed += await finishGoogleFullSync(db, claim.calendarId, state.fullSyncStartedAt);
    }
    await saveGoogleSync(db, claim.calendarId, {
      syncToken: answer.nextSyncToken ?? state.syncToken,
      pageToken: null,
      fullSyncStartedAt: null,
      waiting: [],
      state: "ok",
      nextSyncAt: new Date(Date.now() + GOOGLE_SYNC_EVERY_MS),
      synced: true,
    });
    if (changed > 0) log.info("calendar.google_synced", { calendarId: claim.calendarId, changed });
    return changed > 0;
  }
  await saveGoogleSync(db, claim.calendarId, { ...state, nextSyncAt: new Date() });
  return changed > 0;
}

function fetchPage(pass: Pass, claim: GoogleSyncClaim, state: ReturnType<typeof stateOf>) {
  return callMailService(
    { config: pass.config, requestId: crypto.randomUUID(), log: pass.log },
    GOOGLE_CALENDAR_EVENTS_PATH,
    {
      orgId: claim.orgId,
      mailboxId: claim.mailboxId,
      ...(claim.googleId ? { calendarId: claim.googleId } : {}),
      ...(state.syncToken ? { syncToken: state.syncToken } : {}),
      ...(state.pageToken ? { pageToken: state.pageToken } : {}),
    },
    googleCalendarEventsResultSchema,
  );
}

function changesOf(page: Page) {
  return page.items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);
}
