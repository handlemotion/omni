import {
  GOOGLE_CALENDAR_EVENTS_PATH,
  googleCalendarEventsResultSchema,
  type GoogleCalendarEventsResult,
} from "@omni/contracts";
import {
  applyGoogleChanges,
  claimGoogleCalendars,
  finishGoogleFullSync,
  liveGmailMailboxes,
  saveGoogleSync,
  type Db,
  type GoogleSyncClaim,
} from "@omni/db";
import { readGoogleEvent, type GoogleCalendarChange } from "@omni/mail-core/calendar";
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
 * The calendar's Google sync (`docs/spec/calendar.md`, "Google calendars"): each due Gmail inbox's
 * calendar asks the mail service for what changed in its Google Calendar since the last pass,
 * and applies it. The first pass, and any after Google forgets the sync token, reads the whole
 * calendar and then drops the Google events it no longer has. Returns the calendars that changed.
 */
export async function syncGoogleCalendars(db: Db, config: Config, log: Logger, now = new Date()) {
  if (!config.auth.google) return [];
  const claims = await claimGoogleCalendars(db, await liveGmailMailboxes(db), {
    now,
    limit: CALENDARS_PER_PASS,
  });
  const pass: Pass = { db, config, log, deadline: Date.now() + PASS_BUDGET_MS };
  const changed: { calendarId: string; mailboxId: string }[] = [];
  for (const claim of claims) {
    if (Date.now() > pass.deadline) {
      await saveGoogleSync(db, claim.calendarId, { ...stateOf(claim), nextSyncAt: new Date() });
      continue;
    }
    try {
      if (await syncOne(pass, claim)) {
        changed.push({ calendarId: claim.calendarId, mailboxId: claim.mailboxId });
      }
    } catch (error) {
      log.warn("calendar.google_failed", { calendarId: claim.calendarId, error });
      await saveGoogleSync(db, claim.calendarId, {
        ...stateOf(claim),
        nextSyncAt: new Date(Date.now() + FAILED_RETRY_MS),
      });
    }
  }
  return changed;
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
