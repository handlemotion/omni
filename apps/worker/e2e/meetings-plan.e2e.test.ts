import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { BILLING_SECRETS, PLAN_PRICES } from "./stripe-events.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: {
      ...PLAN_PRICES,
      RATE_LIMIT_AUTH: "off",
      TRANSCRIBE_PROVIDER: "assemblyai",
      TRANSCRIBE_URL: "http://127.0.0.1:9",
    },
    secrets: { ...BILLING_SECRETS, TRANSCRIBE_API_KEY: "unused" },
  });
}, 120_000);
afterAll(() => stack?.stop());

async function api(person: Person, path: string, payload: unknown) {
  const response = await fetch(new URL(`/api/meetings${path}`, stack.worker.url), {
    method: "POST",
    headers: { cookie: person.jar.header, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as {
    code?: string;
    details?: Record<string, unknown>;
    meetingId?: string;
    folderId?: string;
  };
  return { status: response.status, body };
}

const start = (person: Person) => api(person, "", { attendees: [], consent: true });

async function minutesUsed(orgId: string) {
  const rows = await stack.db
    .select({ amount: schema.usageClaims.amount })
    .from(schema.usageClaims)
    .where(
      and(eq(schema.usageClaims.orgId, orgId), eq(schema.usageClaims.meter, "meeting_minutes")),
    );
  return rows.reduce((sum, row) => sum + row.amount, 0);
}

test("meetings need a paid plan; a stopped recording's minutes count once; a used-up month refuses the next", async () => {
  const org = await stack.company(`meet-${randomUUID().slice(0, 8)}`);
  const dana = await stack.member(org.id, "owner");

  expect(await start(dana)).toMatchObject({
    status: 402,
    body: { code: "PLAN_REQUIRED", details: { feature: "meetings" } },
  });

  const periodStart = new Date(Date.now() - 86_400_000);
  await stack.db.insert(schema.subscriptions).values({
    id: randomUUID(),
    plan: "team",
    orgId: org.id,
    status: "active",
    billingInterval: "month",
    periodStart,
    periodEnd: new Date(periodStart.getTime() + 30 * 86_400_000),
  });
  const started = await start(dana);
  expect(started.status).toBe(201);
  const { meetingId, folderId } = started.body as { meetingId: string; folderId: string };
  const node = await stack.upload(
    dana.jar,
    { parentId: folderId },
    "call.ogg",
    new Uint8Array(64),
    "audio/ogg",
  );
  const stop = { audioNodeId: node.id, durationMs: 95_400, micSpans: null };
  expect((await api(dana, `/${meetingId}/stop`, stop)).status).toBe(204);
  expect(await minutesUsed(org.id)).toBe(2);
  await api(dana, `/${meetingId}/stop`, stop);
  expect(await minutesUsed(org.id)).toBe(2);

  await stack.db.insert(schema.usageClaims).values({
    orgId: org.id,
    periodStart,
    meter: "meeting_minutes",
    key: "e2e-fill",
    amount: 15 * 60 - 2,
  });
  const full = await start(dana);
  expect(full).toMatchObject({
    status: 402,
    body: { code: "ALLOWANCE_REACHED", details: { meter: "meetingMinutes" } },
  });
});
