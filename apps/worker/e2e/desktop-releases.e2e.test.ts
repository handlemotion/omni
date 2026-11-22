import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDatabase, startMailServiceEndpoint, startWorker } from "./support.ts";

interface Bucket {
  put(
    key: string,
    body: string,
    options?: { httpMetadata?: { contentDisposition?: string } },
  ): Promise<unknown>;
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

  const exe = await fetch(new URL("/desktop/download/windows", worker.url));
  expect(exe.status).toBe(404);

  const outside = await fetch(new URL("/desktop/releases/latest.json", worker.url));
  expect(outside.status).toBe(404);
});

test("Windows has its own feed and installer, apart from the Mac's", async () => {
  const bucket = (await worker.server.getWorker<{ DESKTOP_BUCKET: Bucket }>().getEnv())
    .DESKTOP_BUCKET;
  const mac = JSON.stringify({ version: "0.2.0", platforms: { "darwin-aarch64": {} } });
  const windows = JSON.stringify({ version: "0.2.1", platforms: { "windows-x86_64": {} } });
  await bucket.put("latest.json", mac);
  await bucket.put("windows/latest.json", windows);
  await bucket.put("releases/0.2.1/Omni_0.2.1_x64-setup.exe", "setup");
  await bucket.put("download/windows.exe", "exe");

  expect(await (await fetch(new URL("/desktop/latest.json", worker.url))).text()).toBe(mac);
  const feed = await fetch(new URL("/desktop/windows/latest.json", worker.url));
  expect(feed.headers.get("content-type")).toBe("application/json");
  expect(await feed.text()).toBe(windows);

  const setup = await fetch(
    new URL("/desktop/releases/0.2.1/Omni_0.2.1_x64-setup.exe", worker.url),
  );
  expect(await setup.text()).toBe("setup");

  const exe = await fetch(new URL("/desktop/download/windows", worker.url));
  expect(exe.headers.get("content-disposition")).toBe('attachment; filename="Omni-Setup.exe"');
  expect(await exe.text()).toBe("exe");
});

test("the installer link downloads under its release's own name", async () => {
  const bucket = (await worker.server.getWorker<{ DESKTOP_BUCKET: Bucket }>().getEnv())
    .DESKTOP_BUCKET;
  const named = (filename: string) => ({
    httpMetadata: { contentDisposition: `attachment; filename="${filename}"` },
  });
  await bucket.put("download/macos.dmg", "dmg", named("Omni_0.5.0_universal.dmg"));
  await bucket.put("download/windows.exe", "exe", named("Omni_0.5.0_x64-setup.exe"));

  const dmg = await fetch(new URL("/desktop/download/macos", worker.url));
  expect(dmg.headers.get("content-disposition")).toBe(
    'attachment; filename="Omni_0.5.0_universal.dmg"',
  );
  expect(await dmg.text()).toBe("dmg");
  const exe = await fetch(new URL("/desktop/download/windows", worker.url));
  expect(exe.headers.get("content-disposition")).toBe(
    'attachment; filename="Omni_0.5.0_x64-setup.exe"',
  );
  expect(await exe.text()).toBe("exe");
});
