import { randomUUID } from "node:crypto";
import {
  ERROR_FORMAT_HEADER,
  errorBodyV2Schema,
  legacyErrorBodySchema,
  toApiError,
} from "@omni/contracts";
import { schema } from "@omni/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BILLING_SECRETS, MONTHLY_PRICE } from "./stripe-events.ts";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let cookie: string;

const nested = { [ERROR_FORMAT_HEADER]: "2" };

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      BILLING_TRIAL_DAYS: "14",
      BILLING_TRIAGE_ALLOWANCE: "500",
      RATE_LIMIT_STORAGE_LINK: "1/60",
    },
    secrets: BILLING_SECRETS,
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrg(database.db, "unpaid");
  const email = `owner-${randomUUID().slice(0, 8)}@omni.test`;
  const owner = await createMember(database.db, org.id, email);
  await database.db
    .update(schema.members)
    .set({ role: "owner" })
    .where(eq(schema.members.id, owner.id));
  cookie = await signIn(worker, database.db, email);
}, 60_000);

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

async function call(
  path: string,
  init: { method?: string; headers?: object; body?: unknown } = {},
) {
  const response = await fetch(new URL(path, worker.url), {
    method: init.method ?? "GET",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      ...init.headers,
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("an old client that sends no header still gets `error` as the message string", async () => {
  const missing = await call(`/api/storage/nodes?parent=${randomUUID()}`);
  expect(missing.status).toBe(404);
  expect(legacyErrorBodySchema.parse(missing.body)).toMatchObject({
    error: "not found",
    code: "NOT_FOUND",
    category: "not_found",
    retryable: false,
  });
  expect(missing.body.requestId).toBe(missing.headers.get("x-request-id"));
  expect(toApiError(missing.body, "fallback")).toMatchObject({ code: "not_found" });
});

test("a tab of the Files UI opened before this format still gets the upper-case codes it matches", async () => {
  const refused = await call("/api/storage/folders", {
    method: "POST",
    body: { name: "Plans", space: "personal" },
  });
  expect(refused.status).toBe(402);
  expect(legacyErrorBodySchema.parse(refused.body)).toMatchObject({
    code: "BILLING_INACTIVE",
    category: "billing",
  });
});

test("a client that sends the header gets the nested shape for the same failure", async () => {
  const missing = await call(`/api/storage/nodes?parent=${randomUUID()}`, { headers: nested });
  expect(missing.status).toBe(404);
  const { error } = errorBodyV2Schema.parse(missing.body);
  expect(error).toMatchObject({ code: "not_found", category: "not_found", message: "not found" });
  expect(error.requestId).toBe(missing.headers.get("x-request-id"));
  expect(toApiError(missing.body, "fallback")).toMatchObject({ code: "not_found" });
});

test("a validation error names the offending field in `param` and lists the issues", async () => {
  const invalid = await call("/api/storage/nodes?space=everyone", { headers: nested });
  expect(invalid.status).toBe(400);
  const { error } = errorBodyV2Schema.parse(invalid.body);
  expect(error).toMatchObject({ code: "bad_request", category: "validation", param: "space" });
  expect(error.details?.issues).toEqual([
    expect.objectContaining({ path: ["space"], code: "invalid_value" }),
  ]);
  expect(JSON.stringify(invalid.body)).not.toContain("everyone");
});

test("a rate-limited request answers 429 with `error.limit` and the rate-limit headers", async () => {
  const shareId = randomUUID();
  const first = await call(`/api/storage/shared/${shareId}`, { headers: nested });
  expect(first.status).toBe(404);
  const limited = await call(`/api/storage/shared/${shareId}`, { headers: nested });
  expect(limited.status).toBe(429);
  const { error } = errorBodyV2Schema.parse(limited.body);
  expect(error).toMatchObject({
    code: "rate_limited",
    category: "rate_limit",
    retryable: true,
    limit: { remaining: 0, total: 1 },
  });
  const retryAfter = Number(limited.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(limited.headers.get("x-ratelimit-limit")).toBe("1");
  expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
  expect(Number(limited.headers.get("x-ratelimit-reset"))).toBe(error.limit?.reset);
  expect(error.limit!.resetMs).toBeGreaterThan(Date.now());
});

test("a write in a workspace without a plan answers 402 `billing_inactive`", async () => {
  const refused = await call("/api/storage/folders", {
    method: "POST",
    headers: nested,
    body: { name: "Plans", space: "personal" },
  });
  expect(refused.status).toBe(402);
  expect(errorBodyV2Schema.parse(refused.body).error).toMatchObject({
    code: "billing_inactive",
    category: "billing",
    retryable: false,
  });
});

test("an unhandled throw answers 500 `internal_server_error` and leaks nothing", async () => {
  await database.db.execute(sql`alter table storage_nodes rename to storage_nodes_away`);
  try {
    const broken = await call("/api/storage/nodes?space=personal", { headers: nested });
    expect(broken.status).toBe(500);
    const { error } = errorBodyV2Schema.parse(broken.body);
    expect(error).toMatchObject({
      code: "internal_server_error",
      category: "internal",
      message: "internal error",
    });
    expect(JSON.stringify(broken.body)).not.toMatch(/storage_nodes|relation|select/i);
  } finally {
    await database.db.execute(sql`alter table storage_nodes_away rename to storage_nodes`);
  }
});
