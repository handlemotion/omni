import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDatabase, startMailServiceEndpoint, startWorker } from "./support.ts";

interface Bucket {
  put(key: string, body: string): Promise<unknown>;
}

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

test("before any release the feed is a 404, not the web app", async () => {
  const response = await fetch(new URL("/desktop/latest.json", worker.url));
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("a published release is what the updater and the installer link get", async () => {
  const bucket = (await worker.server.getWorker<{ DESKTOP_BUCKET: Bucket }>().getEnv())
    .DESKTOP_BUCKET;
  const manifest = JSON.stringify({ version: "0.1.0", platforms: {} });
  await bucket.put("latest.json", manifest);
  await bucket.put("releases/0.1.0/Omni.app.tar.gz", "archive");
  await bucket.put("download/macos.dmg", "dmg");

  const feed = await fetch(new URL("/desktop/latest.json", worker.url));
  expect(feed.status).toBe(200);
  expect(feed.headers.get("cache-control")).toBe("public, max-age=60");
  expect(await feed.text()).toBe(manifest);

  const archive = await fetch(new URL("/desktop/releases/0.1.0/Omni.app.tar.gz", worker.url));
  expect(await archive.text()).toBe("archive");

  const dmg = await fetch(new URL("/desktop/download/macos", worker.url));
  expect(dmg.headers.get("content-disposition")).toBe('attachment; filename="Omni.dmg"');
  expect(await dmg.text()).toBe("dmg");

  const outside = await fetch(new URL("/desktop/releases/latest.json", worker.url));
  expect(outside.status).toBe(404);
});
