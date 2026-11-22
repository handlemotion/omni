import {
  GOOGLE_CALENDAR_LIST_MAX,
  GOOGLE_CALENDAR_PAGE_MAX,
  type GoogleCalendarEventsBody,
  type GoogleCalendarEventsResult,
  type GoogleCalendarListBody,
  type GoogleCalendarListResult,
} from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, findOrgMailboxById } from "@omni/db";
import { z } from "zod";
import { openCredentials } from "../credentials.ts";
import type { Logger } from "../log.ts";
import type { TokenSource } from "../mailbox-connection.ts";
import { ProvisionError } from "../provisioning.ts";
import { type GoogleOAuth, googleTokenSource } from "./gmail.ts";

const API_URL = "https://www.googleapis.com/calendar/v3";
const eventsUrl = (calendarId = "primary") =>
  `${API_URL}/calendars/${encodeURIComponent(calendarId)}/events`;
const LIST_URL = `${API_URL}/users/me/calendarList`;
const LIST_PAGE = 250;
const LIST_FIELDS =
  "nextPageToken,items(id,summary,summaryOverride,backgroundColor,primary,deleted)";

const FIELDS = [
  "timeZone",
  "nextPageToken",
  "nextSyncToken",
  "items(id,status,iCalUID,sequence,updated,summary,description,location,start,end," +
    "recurrence,recurringEventId,originalStartTime,transparency,eventType,organizer," +
    "attendees(email,displayName,organizer,optional,resource,responseStatus)," +
    "hangoutLink,conferenceData/entryPoints(entryPointType,uri))",
].join(",");

const listPage = z.object({
  items: z.array(z.unknown()).max(LIST_PAGE).default([]),
  nextPageToken: z.string().max(4096).optional(),
});

const page = z.object({
  timeZone: z.string().max(100).optional(),
  items: z.array(z.unknown()).max(GOOGLE_CALENDAR_PAGE_MAX).default([]),
  nextPageToken: z.string().max(4096).optional(),
  nextSyncToken: z.string().max(4096).optional(),
});

const errorBody = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    status: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

function reasonsOf(json: unknown) {
  const parsed = errorBody.safeParse(json);
  if (!parsed.success) return [];
  const { errors = [], details = [], status } = parsed.data.error;
  return [...errors, ...details].flatMap((e) => (e.reason ? [e.reason] : [])).concat(status ?? []);
}

const NO_SCOPE = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const API_DISABLED = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);

export interface GoogleCalendarDeps {
  db: Db;
  keyring: Keyring;
  oauth: GoogleOAuth;
  logger: Logger;
  fetch?: typeof fetch;
}

type NoAccess = Extract<GoogleCalendarListResult, { status: "no_access" }>;
const noAccess = (reason: NoAccess["reason"]) =>
  ({ status: "no_access", reason }) satisfies NoAccess;

/**
 * Reads Gmail inboxes' Google calendars for the Worker: the calendar list, and one page of one
 * calendar's events. Access tokens are cached per inbox, apart from its IMAP connection's: Google
 * gives a refresh token any number of them.
 */
export function createGoogleCalendar(deps: GoogleCalendarDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  const tokens = new Map<string, { refreshToken: string; source: TokenSource }>();

  async function tokenFor(input: { orgId: string; mailboxId: string }) {
    const mailbox = await findOrgMailboxById(deps.db, input.orgId, input.mailboxId);
    if (!mailbox) throw new ProvisionError(404, "No such mailbox");
    if (mailbox.provider !== "gmail") return null;
    const credentials = await openCredentials(deps.keyring, mailbox.id, mailbox.credentialsEnc);
    if (!("oauth" in credentials)) return null;
    let cached = tokens.get(mailbox.id);
    if (cached?.refreshToken !== credentials.refreshToken) {
      cached = {
        refreshToken: credentials.refreshToken,
        source: googleTokenSource(deps.oauth, credentials),
      };
      tokens.set(mailbox.id, cached);
    }
    return cached.source;
  }

  const send = (url: URL, token: string) =>
    fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

  async function get(input: { orgId: string; mailboxId: string }, url: URL) {
    const source = await tokenFor(input);
    if (!source) return noAccess("not_gmail");
    let response: Response;
    try {
      response = await send(url, await source.get());
      if (response.status === 401) {
        source.invalidate();
        response = await send(url, await source.get());
      }
    } catch (error) {
      if (source.isRevoked(error)) return noAccess("revoked");
      deps.logger.warn("google_calendar.unreachable", { mailboxId: input.mailboxId, error });
      throw new ProvisionError(502, "Google Calendar could not be reached");
    }
    const json: unknown = await response.json().catch(() => null);
    if (response.status === 410) return { status: "reset" as const };
    if (response.status === 403 || response.status === 401) {
      const reasons = reasonsOf(json);
      if (reasons.some((r) => NO_SCOPE.has(r)) || response.status === 401) {
        return noAccess("no_scope");
      }
      if (reasons.some((r) => API_DISABLED.has(r))) {
        deps.logger.warn("google_calendar.api_disabled", { mailboxId: input.mailboxId });
        return noAccess("api_disabled");
      }
    }
    if (!response.ok) throw refused(input, response.status, json);
    return { status: "ok" as const, json };
  }

  function refused(input: { mailboxId: string }, status: number, json: unknown) {
    deps.logger.warn("google_calendar.refused", {
      mailboxId: input.mailboxId,
      status,
      reasons: reasonsOf(json),
    });
    return new ProvisionError(502, "Google Calendar did not answer as expected");
  }

  async function events(input: GoogleCalendarEventsBody) {
    const url = new URL(eventsUrl(input.calendarId));
    url.searchParams.set("maxResults", String(GOOGLE_CALENDAR_PAGE_MAX));
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "false");
    url.searchParams.set("fields", FIELDS);
    if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    const answer = await get(input, url);
    if (answer.status !== "ok") return answer;
    const parsed = page.safeParse(answer.json);
    if (!parsed.success) throw refused(input, 200, answer.json);
    return {
      status: "ok",
      timeZone: parsed.data.timeZone ?? null,
      items: parsed.data.items,
      nextPageToken: parsed.data.nextPageToken ?? null,
      nextSyncToken: parsed.data.nextSyncToken ?? null,
    } satisfies GoogleCalendarEventsResult;
  }

  async function list(input: GoogleCalendarListBody) {
    const items: unknown[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(LIST_URL);
      url.searchParams.set("maxResults", String(LIST_PAGE));
      url.searchParams.set("fields", LIST_FIELDS);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const answer = await get(input, url);
      if (answer.status === "no_access") return answer;
      const parsed = answer.status === "ok" ? listPage.safeParse(answer.json) : null;
      if (!parsed?.success) throw refused(input, 200, null);
      items.push(...parsed.data.items);
      pageToken = parsed.data.nextPageToken;
    } while (pageToken && items.length < GOOGLE_CALENDAR_LIST_MAX);
    return {
      status: "ok",
      items: items.slice(0, GOOGLE_CALENDAR_LIST_MAX),
    } satisfies GoogleCalendarListResult;
  }

  return { events, list };
}
