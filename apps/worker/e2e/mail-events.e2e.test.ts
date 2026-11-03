import type { MailEventsBody } from "@omni/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createTestDatabase,
  postMailEvents,
  startMailServiceEndpoint,
  startWorker,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

const someEvents: MailEventsBody = {
  events: [
    {
      type: "message.created",
      orgId: "o",
      mailboxId: "m",
      threadId: "t",
      messageId: "x",
      folderRole: "inbox",
    },
  ],
};

test("forged, expired, unsigned-nonce and replayed mail events are rejected", async () => {
  const forged = await postMailEvents(worker, someEvents, {
    secret: "not-the-shared-secret-not-the-shared-secret",
  });
  expect(forged.status).toBe(401);

  const expired = await postMailEvents(worker, someEvents, {
    timestamp: Math.floor(Date.now() / 1000) - 120,
  });
  expect(expired.status).toBe(401);
  expect(await expired.json()).toEqual({ error: "expired" });

  const noNonce = await postMailEvents(worker, someEvents, { nonce: null });
  expect(noNonce.status).toBe(401);

  const nonce = "replay-nonce-0000000001";
  const timestamp = Math.floor(Date.now() / 1000);
  const valid = await postMailEvents(worker, someEvents, { nonce, timestamp });
  expect(valid.status).toBe(202);
  const replayed = await postMailEvents(worker, someEvents, { nonce, timestamp });
  expect(replayed.status).toBe(401);
  expect(await replayed.json()).toEqual({ error: "replayed" });
});

test("event types this Worker does not know are accepted and ignored, so deploy skew never wedges retries", async () => {
  const response = await postMailEvents(
    worker,
    JSON.stringify({ events: [{ type: "folder.renamed", mailboxId: "m" }] }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, jobs: 0 });
});
