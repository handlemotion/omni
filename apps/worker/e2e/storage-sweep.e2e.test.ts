// The bucket sweep's guard (ADR 0034 decision 1) over the real Worker and its local R2: a sweep
// deletes whatever names no workspace in the database, so a database that is not this bucket's
// must make it stop, not empty the bucket.
import { randomUUID } from "node:crypto";
import { storageObjectKey } from "@omni/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { workerEvents } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const refusals = () =>
  workerEvents(stack.worker).filter((event) => event.event === "storage.sweep_refused");

/** Objects under `count` workspace ids the database has never heard of. */
async function strangers(count: number) {
  const bucket = await stack.bucket();
  const keys = Array.from({ length: count }, () => storageObjectKey(randomUUID(), randomUUID()));
  for (const key of keys) await bucket.put(key, "someone's file");
  return keys;
}

// Catches: every file in the bucket deleted because the Worker was pointed at an empty database
// (a new install on an old bucket, a restore that has not finished).
test("with no workspace in the database the sweep deletes nothing", async () => {
  const bucket = await stack.bucket();
  const keys = await strangers(3);

  expect(await stack.cron("47 3 * * *")).toBe("ok");

  for (const key of keys) expect(await bucket.head(key)).not.toBeNull();
  expect(refusals()).toMatchObject([{ level: "error", reason: "no_workspaces" }]);
});

// Catches: a second install (staging beside production), or a database restored from before
// most workspaces existed, sweeping the other's files: to it they all look deleted.
test("when most of the bucket's workspaces are unknown to the database the sweep deletes nothing", async () => {
  const bucket = await stack.bucket();
  const org = await stack.company("the-only-one");
  const ana = await stack.member(org.id);
  const mine = await stack.upload(ana.jar, { space: "personal" }, "mine.txt", Buffer.from("ana"));
  const keys = await strangers(25);
  const before = refusals().length;

  for (let run = 0; run < 2; run++) expect(await stack.cron("47 3 * * *")).toBe("ok");

  for (const key of keys) expect(await bucket.head(key)).not.toBeNull();
  expect(await bucket.head(storageObjectKey(org.id, mine.id))).not.toBeNull();
  const refused = refusals().slice(before);
  expect(refused).toHaveLength(2);
  expect(refused[0]).toMatchObject({ level: "error", reason: "mostly_unknown" });
});
