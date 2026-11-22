import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCalendar } from "@omni/mail-core/calendar";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startCrmStack, type CrmStack, type Person } from "./crm-support.ts";
import { createMailbox, grant, postMailEvents, seedMessage, type CookieJar } from "./support.ts";

const invite = readFileSync(
  join(import.meta.dirname, "../../../fixtures/ics/google-invite.ics"),
  "utf8",
);

let stack: CrmStack;
beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);
afterAll(() => stack?.stop());

async function api(jar: CookieJar, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/calendar${path}`, stack.worker.url), {
    method,
    headers: { cookie: jar.header, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

interface MailBucket {
  put(key: string, body: string): Promise<unknown>;
}

let uid = 0;

async function invited(inboxAddress = `hello-${crypto.randomUUID().slice(0, 6)}@studio.example`) {
  const org = await stack.company(`calendar-${crypto.randomUUID().slice(0, 8)}`);
  const rodrigo = await stack.member(org.id);
  const outsider = await stack.member(org.id);
  const inbox = await createMailbox(stack.db, org.id, inboxAddress, "shared");
  await grant(stack.db, org.id, inbox.id, rodrigo.id);
  const ics = invite
    .replaceAll("rodrigo@studio.example", inboxAddress)
    .replace("Rodrigo@Studio.example", inboxAddress);
  const seeded = await seedMessage(stack.db, inbox, {
    subject: "Invitation: Acme × Studio: kickoff",
    fromAddress: "ana@acme.example",
    uid: ++uid,
    messageId: `<invite-${crypto.randomUUID()}@google.com>`,
  });
  const r2Key = `${org.id}/${inbox.id}/att/${crypto.randomUUID()}`;
  const env = await stack.worker.server.getWorker<{ MAIL_BUCKET: MailBucket }>().getEnv();
  await env.MAIL_BUCKET.put(r2Key, ics);
  await stack.db.insert(schema.attachments).values({
    orgId: org.id,
    messageId: seeded.messageId,
    filename: "invite.ics",
    mimeType: "text/calendar",
    size: ics.length,
    r2Key,
  });
  await postMailEvents(stack.worker, {
    events: [
      {
        type: "message.created",
        orgId: org.id,
        mailboxId: inbox.id,
        threadId: seeded.threadId,
        messageId: seeded.messageId,
        folderRole: "inbox",
      },
    ],
  });
  const event = await until(async () => {
    const found = await api(rodrigo.jar, "GET", `/events?${window}`);
    return found.body?.events?.[0];
  });
  return { org, rodrigo, outsider, inbox, event, threadId: seeded.threadId, address: inboxAddress };
}

const window = `from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z`;

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sends = (mailboxId: string) =>
  stack.db
    .select()
    .from(schema.mailActions)
    .where(and(eq(schema.mailActions.mailboxId, mailboxId), eq(schema.mailActions.kind, "send")))
    .orderBy(schema.mailActions.createdAt);

type SendRow = Awaited<ReturnType<typeof sends>>[number];
const payloadOf = (row: SendRow | undefined) =>
  row?.payload as {
    from: string;
    to: string[];
    subject: string;
    inReplyTo?: string;
    calendar?: { method: string; ics: string };
  };

function icsOf(row: SendRow | undefined) {
  const parsed = parseCalendar(payloadOf(row)?.calendar?.ics ?? "");
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.calendar;
}

describe("answering an invitation", () => {
  test("Yes queues one REPLY from the invited inbox to the organizer, in the thread, and a retry queues no second", async () => {
    const { rodrigo, inbox, event, address, threadId } = await invited();
    expect(event).toMatchObject({ title: "Acme × Studio: kickoff", myResponse: "needs_action" });

    const socket = await stack.socket(rodrigo.jar);
    const first = await api(rodrigo.jar, "POST", `/events/${event.id}/answer`, {
      response: "accepted",
    });
    expect(first.status).toBe(200);
    expect(first.body.event.myResponse).toBe("accepted");
    await socket.waitFor((e) => e.type === "calendar.changed");
    socket.close();

    const retried = await api(rodrigo.jar, "POST", `/events/${event.id}/answer`, {
      response: "accepted",
    });
    expect(retried.status).toBe(200);
    const queued = await sends(inbox.id);
    expect(queued).toHaveLength(1);
    expect(payloadOf(queued[0])).toMatchObject({
      from: address,
      to: ["ana@acme.example"],
      subject: "Accepted: Acme × Studio: kickoff",
      calendar: { method: "REPLY" },
    });
    expect(payloadOf(queued[0])?.inReplyTo).toMatch(/^<invite-.*@google\.com>$/);
    const reply = icsOf(queued[0]);
    expect(reply.method).toBe("REPLY");
    expect(reply.events[0]?.attendees).toEqual([
      expect.objectContaining({ address, response: "accepted" }),
    ]);

    const declined = await api(rodrigo.jar, "POST", `/events/${event.id}/answer`, {
      response: "declined",
    });
    expect(declined.body.event.myResponse).toBe("declined");
    expect(await sends(inbox.id)).toHaveLength(2);

    const card = await api(rodrigo.jar, "GET", `/invites?thread=${threadId}`);
    expect(card.body.invites).toEqual([
      expect.objectContaining({
        method: "REQUEST",
        event: expect.objectContaining({ id: event.id, myResponse: "declined" }),
      }),
    ]);
    const detail = await api(rodrigo.jar, "GET", `/events/${event.id}`);
    expect(detail.body.threadId).toBe(threadId);
  });

  test("an invitation's details are its organizer's: changing it is refused", async () => {
    const { rodrigo, event } = await invited();
    const changed = await api(rodrigo.jar, "PATCH", `/events/${event.id}`, { title: "Mine now" });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("NOT_ORGANIZER");
    expect((await api(rodrigo.jar, "DELETE", `/events/${event.id}`)).status).toBe(409);
  });
});

describe("who sees a calendar", () => {
  test("a teammate without the inbox gets 404 for its events, invites, calendar and answers", async () => {
    const { outsider, event, threadId, inbox } = await invited();
    const calendars = await api(outsider.jar, "GET", "/calendars");
    expect(calendars.body.calendars).toEqual([]);
    expect((await api(outsider.jar, "GET", `/events?${window}`)).body.events).toEqual([]);
    expect((await api(outsider.jar, "GET", `/events/${event.id}`)).status).toBe(404);
    expect((await api(outsider.jar, "GET", `/invites?thread=${threadId}`)).status).toBe(404);
    expect(
      (await api(outsider.jar, "POST", `/events/${event.id}/answer`, { response: "accepted" }))
        .status,
    ).toBe(404);
    expect(
      (await api(outsider.jar, "PATCH", `/calendars/${event.calendarId}`, { hidden: true })).status,
    ).toBe(404);
    expect(await sends(inbox.id)).toEqual([]);
  });

  test("hiding a calendar takes its events off the member's week, and only theirs", async () => {
    const { org, rodrigo, inbox, event } = await invited();
    const teammate = await stack.member(org.id);
    await grant(stack.db, org.id, inbox.id, teammate.id);
    expect(
      (
        await api(rodrigo.jar, "PATCH", `/calendars/${event.calendarId}`, {
          hidden: true,
          color: "#3366ff",
        })
      ).status,
    ).toBe(204);
    expect((await api(rodrigo.jar, "GET", "/calendars")).body.calendars).toEqual([
      expect.objectContaining({ id: event.calendarId, hidden: true, color: "#3366ff" }),
    ]);
    expect((await api(rodrigo.jar, "GET", `/events?${window}`)).body.events).toEqual([]);
    expect(
      (await api(rodrigo.jar, "GET", `/events?${window}&calendar=${event.calendarId}`)).body.events,
    ).toHaveLength(1);
    expect((await api(teammate.jar, "GET", `/events?${window}`)).body.events).toHaveLength(1);
  });

  test("a window over 62 days is refused", async () => {
    const { rodrigo } = await invited();
    const read = await api(
      rodrigo.jar,
      "GET",
      "/events?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z",
    );
    expect(read.status).toBe(400);
    expect(read.body.code).toBe("WINDOW_TOO_LARGE");
  });
});

describe("events made in Omni", () => {
  async function ownCalendar(person: Person, orgId: string) {
    const address = `rodrigo-${crypto.randomUUID().slice(0, 6)}@studio.example`;
    const inbox = await createMailbox(stack.db, orgId, address, "personal");
    await grant(stack.db, orgId, inbox.id, person.id);
    const listed = await api(person.jar, "GET", "/calendars");
    const calendar = listed.body.calendars.find(
      (c: { mailboxId: string }) => c.mailboxId === inbox.id,
    );
    return { inbox, address, calendarId: calendar.id as string };
  }

  test("inviting, moving, dropping a guest and deleting each send what the guests' calendars need", async () => {
    const org = await stack.company(`own-${crypto.randomUUID().slice(0, 8)}`);
    const rodrigo = await stack.member(org.id);
    const { inbox, address, calendarId } = await ownCalendar(rodrigo, org.id);

    const made = await api(rodrigo.jar, "POST", "/events", {
      calendarId,
      title: "Design review",
      start: "2026-11-25T10:00:00Z",
      end: "2026-11-25T11:00:00Z",
      timeZone: "Europe/Madrid",
      conferenceUrl: "https://meet.google.com/xyz-abcd-efg",
      guests: [{ address: "Ana@Acme.example", name: "Ana" }, { address: "luis@acme.example" }],
    });
    expect(made.status).toBe(201);
    const id = made.body.event.id;
    expect(made.body.event).toMatchObject({
      source: "omni",
      organizing: true,
      myResponse: "accepted",
    });
    let queued = await sends(inbox.id);
    expect(queued.map((row) => payloadOf(row)?.to)).toEqual([
      ["ana@acme.example", "luis@acme.example"],
    ]);
    const request = icsOf(queued[0]);
    expect(request).toMatchObject({ method: "REQUEST" });
    expect(request.events[0]).toMatchObject({
      sequence: 0,
      organizer: { address },
      start: new Date("2026-11-25T10:00:00Z"),
      conferenceUrl: "https://meet.google.com/xyz-abcd-efg",
    });

    const moved = await api(rodrigo.jar, "PATCH", `/events/${id}`, {
      start: "2026-11-25T12:00:00Z",
      end: "2026-11-25T13:00:00Z",
      guests: [{ address: "ana@acme.example", name: "Ana" }],
    });
    expect(moved.status).toBe(200);
    queued = await sends(inbox.id);
    expect(queued).toHaveLength(3);
    const update = icsOf(queued[1]);
    expect(payloadOf(queued[1])?.to).toEqual(["ana@acme.example"]);
    expect(update.events[0]).toMatchObject({
      sequence: 1,
      start: new Date("2026-11-25T12:00:00Z"),
    });
    expect(
      update.events[0]?.attendees.find((a) => a.address === "ana@acme.example")?.response,
    ).toBe("needs_action");
    expect(payloadOf(queued[2])).toMatchObject({
      to: ["luis@acme.example"],
      calendar: { method: "CANCEL" },
    });

    expect((await api(rodrigo.jar, "DELETE", `/events/${id}`)).status).toBe(204);
    queued = await sends(inbox.id);
    expect(queued).toHaveLength(4);
    expect(payloadOf(queued[3])).toMatchObject({
      to: ["ana@acme.example"],
      calendar: { method: "CANCEL" },
    });
    expect(icsOf(queued[3]).events[0]).toMatchObject({ sequence: 2, status: "cancelled" });
    expect((await api(rodrigo.jar, "GET", `/events?${window}`)).body.events).toEqual([]);
  });

  test("an event with no guests sends nothing, and an event that ends before it starts is refused", async () => {
    const org = await stack.company(`solo-${crypto.randomUUID().slice(0, 8)}`);
    const rodrigo = await stack.member(org.id);
    const { inbox, calendarId } = await ownCalendar(rodrigo, org.id);
    const backwards = await api(rodrigo.jar, "POST", "/events", {
      calendarId,
      title: "Focus",
      start: "2026-11-26T11:00:00Z",
      end: "2026-11-26T09:00:00Z",
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body).toMatchObject({ code: "INVALID_EVENT", param: "end" });
    const made = await api(rodrigo.jar, "POST", "/events", {
      calendarId,
      title: "Focus",
      start: "2026-11-26T09:00:00Z",
      end: "2026-11-26T11:00:00Z",
      busy: true,
    });
    expect(made.status).toBe(201);
    expect(await sends(inbox.id)).toEqual([]);
    expect(
      (await api(rodrigo.jar, "GET", `/events?${window}`)).body.events.map(
        (e: { title: string }) => e.title,
      ),
    ).toEqual(["Focus"]);
  });
});
