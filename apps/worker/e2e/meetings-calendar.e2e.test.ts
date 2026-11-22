/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers */
import { readFileSync } from "node:fs";
import { applyGoogleChanges, schema } from "@omni/db";
import { readGoogleEvent, type GoogleCalendarChange } from "@omni/mail-core/calendar";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { createMailbox, grant, WEB_ORIGIN } from "./support.ts";

const page = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/google-calendar/events-page.json", import.meta.url),
    "utf8",
  ),
) as { timeZone: string; items: Record<string, unknown>[] };
const SERIES_UID = "f0c5s1k2wq9series@google.com";
const MOVED = "2026-11-16T09:00:00.000Z";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off", TRANSCRIBE_PROVIDER: "assemblyai" },
    secrets: { TRANSCRIBE_API_KEY: "unused" },
  });
}, 120_000);
afterAll(() => stack?.stop());

async function api(person: Person, method: string, path: string, payload?: unknown) {
  const response = await fetch(new URL(`/api/meetings${path}`, stack.worker.url), {
    method,
    headers: {
      cookie: person.jar.header,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function studio() {
  const org = await stack.company(`meet-cal-${crypto.randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id);
  const ben = await stack.member(org.id);
  const box = await createMailbox(stack.db, org.id, dana.email, "personal", "gmail");
  await grant(stack.db, org.id, box.id, dana.id);
  const [calendar] = await stack.db
    .insert(schema.calendarCalendars)
    .values({ orgId: org.id, mailboxId: box.id })
    .returning();
  const changes = page.items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);
  await applyGoogleChanges(stack.db, { id: calendar!.id, orgId: org.id }, changes);
  const [moved] = await stack.db
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.calendarId, calendar!.id),
        eq(schema.calendarEvents.recurrenceId, new Date(MOVED)),
      ),
    );
  return { dana, ben, moved: moved! };
}

test("a recording started from a moved instance is that instance's, found again by the event, and only for who sees the calendar", async () => {
  const { dana, ben, moved } = await studio();
  const event = { id: moved.id, recurrenceId: "2026-11-16T10:00:00+01:00" };

  const started = await api(dana, "POST", "", { event, consent: true });
  expect(started.status).toBe(201);
  expect((await api(ben, "POST", "", { event, consent: true })).status).toBe(404);

  const again = await api(dana, "POST", "", { event, consent: true });
  expect(again).toMatchObject({
    status: 409,
    body: { status: "recording_elsewhere", meetingId: started.body.meetingId },
  });

  const query = `?event=${encodeURIComponent(SERIES_UID)}&recurrence=${encodeURIComponent(MOVED)}`;
  const found = await api(dana, "GET", query);
  expect(found.status).toBe(200);
  expect(found.body.meetings).toMatchObject([
    {
      id: started.body.meetingId,
      title: "Weekly sync (moved)",
      event: { uid: SERIES_UID, recurrenceId: MOVED },
    },
  ]);
  expect((await api(ben, "GET", query)).body.meetings).toEqual([]);
  const other = `?event=${encodeURIComponent(SERIES_UID)}&recurrence=2026-11-02T09:00:00Z`;
  expect((await api(dana, "GET", other)).body.meetings).toEqual([]);
});

test("a recording with no event named is of none when the recorder is in no meeting", async () => {
  const { ben } = await studio();
  const started = await api(ben, "POST", "", { consent: true });
  expect(started.status).toBe(201);
  expect((await api(ben, "GET", `/${started.body.meetingId}`)).body.meeting.event).toBeNull();
});
