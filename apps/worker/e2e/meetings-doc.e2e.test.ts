import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startMeetingsStack, type MeetingsStack } from "./meetings-support.ts";
import type { Person } from "./storage-support.ts";

let m: MeetingsStack;
beforeAll(async () => {
  m = await startMeetingsStack();
}, 120_000);
afterAll(() => m?.stop());

const DOC_TYPE = "text/vnd.omni.doc";
const marta = { address: "marta@client.test", name: "Marta Gil" };

async function written(person: Person, meetingId: string) {
  const found = await m.until(
    async () => {
      const [meeting] = await m.stack.db
        .select({ notesNodeId: schema.meetingsMeetings.notesNodeId })
        .from(schema.meetingsMeetings)
        .where(eq(schema.meetingsMeetings.id, meetingId));
      const docId = meeting?.notesNodeId ?? null;
      return { docId, body: docId ? await text(person, docId) : "" };
    },
    (r) => r.body.includes(`/meetings/${meetingId})`),
    40_000,
  );
  expect(found.body).toContain(`/meetings/${meetingId})`);
  return found.docId!;
}

const text = async (person: Person, nodeId: string) =>
  (await m.stack.download(person.jar, nodeId)).text();

async function queue(body: unknown) {
  const env = await m.stack.worker.server
    .getWorker<{ AI_QUEUE: { send(body: unknown): Promise<unknown> } }>()
    .getEnv();
  await env.AI_QUEUE.send(body);
}

test("the notes go into one new doc in Recordings, however often the steps run again", async () => {
  const org = await m.stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await m.stack.member(org.id);
  const { meetingId, folderId } = await m.record(dana, {
    title: "Entregas sitio web",
    attendees: [marta],
  });
  const docId = await written(dana, meetingId);
  const [doc] = await m.stack.db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, docId));
  expect(doc).toMatchObject({ parentId: folderId, mimeType: DOC_TYPE });
  const first = await text(dana, docId);
  expect(first).toContain("Written by Omni from the recording of [Entregas sitio web](");
  expect(first).toContain(`/meetings/${meetingId})`);
  expect(first).toMatch(/acceso al servidor/i);
  expect(first).toContain("- [ ] Gestionar el acceso al servidor");

  await m.stack.db
    .update(schema.meetingsMeetings)
    .set({ status: "writing" })
    .where(eq(schema.meetingsMeetings.id, meetingId));
  await queue({ kind: "meeting", meetingId, orgId: org.id, step: "write" });
  await m.until(
    () => m.api(dana, "GET", `/${meetingId}`),
    (r) => r.body?.meeting?.status === "ready",
  );
  await m.stack.db
    .update(schema.meetingsNotes)
    .set({ writtenToDocAt: null })
    .where(eq(schema.meetingsNotes.meetingId, meetingId));
  await queue({ kind: "meeting-doc", meetingId, orgId: org.id });
  await queue({ kind: "meeting-doc", meetingId, orgId: org.id });
  await m.until(
    async () =>
      (
        await m.stack.db
          .select({ at: schema.meetingsNotes.writtenToDocAt })
          .from(schema.meetingsNotes)
          .where(eq(schema.meetingsNotes.meetingId, meetingId))
      )[0]?.at,
    (at) => !!at,
  );

  const after = await text(dana, docId);
  expect(after.split("Written by Omni").length - 1).toBe(1);
  const docs = await m.stack.db
    .select({ id: schema.storageNodes.id })
    .from(schema.storageNodes)
    .where(
      and(
        eq(schema.storageNodes.parentId, folderId),
        eq(schema.storageNodes.mimeType, DOC_TYPE),
        isNull(schema.storageNodes.trashedAt),
      ),
    );
  expect(docs).toEqual([{ id: docId }]);
});

test("a doc someone outside the meeting can open gets a link to it, above what was typed", async () => {
  const org = await m.stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await m.stack.member(org.id);
  const cy = await m.stack.member(org.id);
  const typed = "- my own line about the budget";
  const notes = await m.stack.upload(
    dana.jar,
    { space: "personal" },
    "Call notes",
    new TextEncoder().encode(typed),
    DOC_TYPE,
  );
  const shared = await m.stack.api(
    dana.jar,
    "PUT",
    `/nodes/${notes.id}/sharing/people/${encodeURIComponent(cy.email)}`,
    { role: "viewer" },
  );
  expect(shared.status).toBeLessThan(300);

  const { meetingId } = await m.record(
    dana,
    { title: "Entregas sitio web", attendees: [marta] },
    async (id) => {
      await m.stack.db
        .update(schema.meetingsMeetings)
        .set({ notesNodeId: notes.id })
        .where(eq(schema.meetingsMeetings.id, id));
    },
  );
  expect(await written(dana, meetingId)).toBe(notes.id);
  const doc = await text(dana, notes.id);
  expect(doc.startsWith("_Omni's notes from the recording of [Entregas sitio web](")).toBe(true);
  expect(doc).toContain(`/meetings/${meetingId})`);
  expect(doc).toContain(typed);
  expect(doc).not.toMatch(/acceso/i);
  expect(await text(cy, notes.id)).not.toMatch(/acceso/i);
});

test("a doc under a folder that a link opens, however far up, gets only the link", async () => {
  const org = await m.stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await m.stack.member(org.id);
  const top = await m.stack.api(dana.jar, "POST", "/folders", {
    name: "Shared",
    space: "personal",
  });
  const inner = await m.stack.api(dana.jar, "POST", "/folders", {
    name: "Calls",
    parentId: top.body.node.id,
  });
  const notes = await m.stack.upload(
    dana.jar,
    { parentId: inner.body.node.id },
    "Call notes",
    new TextEncoder().encode("- typed"),
    DOC_TYPE,
  );
  const link = await m.stack.api(dana.jar, "PUT", `/nodes/${top.body.node.id}/sharing/link`, {
    linkAccess: "anyone",
  });
  expect(link.status).toBeLessThan(300);

  const { meetingId } = await m.record(
    dana,
    { title: "Entregas sitio web", attendees: [marta] },
    async (id) => {
      await m.stack.db
        .update(schema.meetingsMeetings)
        .set({ notesNodeId: notes.id })
        .where(eq(schema.meetingsMeetings.id, id));
    },
  );
  await written(dana, meetingId);
  const doc = await text(dana, notes.id);
  expect(doc.startsWith("_Omni's notes from the recording of")).toBe(true);
  expect(doc).not.toMatch(/acceso/i);
});
