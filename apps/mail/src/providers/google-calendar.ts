import {
  GOOGLE_CALENDAR_PAGE_MAX,
  type GoogleCalendarEventsBody,
  type GoogleCalendarEventsResult,
} from "@omni/contracts";
import type { Keyring } from "@omni/crypto";
import { type Db, findOrgMailboxById } from "@omni/db";
import { z } from "zod";
import { openCredentials } from "../credentials.ts";
import type { Logger } from "../log.ts";
import type { TokenSource } from "../mailbox-connection.ts";
import { ProvisionError } from "../provisioning.ts";
import { type GoogleOAuth, googleTokenSource } from "./gmail.ts";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const FIELDS = [
  "timeZone",
  "nextPageToken",
  "nextSyncToken",
  "items(id,status,iCalUID,sequence,updated,summary,description,location,start,end," +
    "recurrence,recurringEventId,originalStartTime,transparency,eventType,organizer," +
    "attendees(email,displayName,organizer,optional,resource,responseStatus)," +
    "hangoutLink,conferenceData/entryPoints(entryPointType,uri))",
].join(",");

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

/**
 * Reads Gmail inboxes' Google calendars for the Worker. Access tokens are cached per inbox, apart
 * from its IMAP connection's: Google gives a refresh token any number of them.
 */
export function createGoogleCalendar(deps: GoogleCalendarDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  const tokens = new Map<string, { refreshToken: string; source: TokenSource }>();

  async function tokenFor(input: GoogleCalendarEventsBody) {
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

  async function list(input: GoogleCalendarEventsBody, token: string) {
    const url = new URL(EVENTS_URL);
    url.searchParams.set("maxResults", String(GOOGLE_CALENDAR_PAGE_MAX));
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "false");
    url.searchParams.set("fields", FIELDS);
    if (input.syncToken) url.searchParams.set("syncToken", input.syncToken);
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    return fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  }

  return async function events(input: GoogleCalendarEventsBody) {
    const source = await tokenFor(input);
    if (!source) {
      return { status: "no_access", reason: "not_gmail" } satisfies GoogleCalendarEventsResult;
    }
    let response: Response;
    try {
      response = await list(input, await source.get());
      if (response.status === 401) {
        source.invalidate();
        response = await list(input, await source.get());
      }
    } catch (error) {
      if (source.isRevoked(error)) {
        return { status: "no_access", reason: "revoked" } satisfies GoogleCalendarEventsResult;
      }
      deps.logger.warn("google_calendar.unreachable", { mailboxId: input.mailboxId, error });
      throw new ProvisionError(502, "Google Calendar could not be reached");
    }
    const json: unknown = await response.json().catch(() => null);
    if (response.status === 410) return { status: "reset" } satisfies GoogleCalendarEventsResult;
    if (response.status === 403 || response.status === 401) {
      const reasons = reasonsOf(json);
      if (reasons.some((r) => NO_SCOPE.has(r)) || response.status === 401) {
        return { status: "no_access", reason: "no_scope" } satisfies GoogleCalendarEventsResult;
      }
      if (reasons.some((r) => API_DISABLED.has(r))) {
        deps.logger.warn("google_calendar.api_disabled", { mailboxId: input.mailboxId });
        return { status: "no_access", reason: "api_disabled" } satisfies GoogleCalendarEventsResult;
      }
    }
    const parsed = response.ok ? page.safeParse(json) : null;
    if (!parsed?.success) {
      deps.logger.warn("google_calendar.refused", {
        mailboxId: input.mailboxId,
        status: response.status,
        reasons: reasonsOf(json),
      });
      throw new ProvisionError(502, "Google Calendar did not answer as expected");
    }
    const result: GoogleCalendarEventsResult = {
      status: "ok",
      timeZone: parsed.data.timeZone ?? null,
      items: parsed.data.items,
      nextPageToken: parsed.data.nextPageToken ?? null,
      nextSyncToken: parsed.data.nextSyncToken ?? null,
    };
    return result;
  };
}
