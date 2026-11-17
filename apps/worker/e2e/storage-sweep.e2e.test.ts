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

async function strangers(count: number) {
  const bucket = await stack.bucket();
  const keys = Array.from({ length: count }, () => storageObjectKey(randomUUID(), randomUUID()));
  for (const key of keys) await bucket.put(key, "someone's file");
  return keys;
}

test("with no workspace in the database the sweep deletes nothing", async () => {
  const bucket = await stack.bucket();
  const keys = await strangers(3);

  expect(await stack.cron("47 3 * * *")).toBe("ok");

  for (const key of keys) expect(await bucket.head(key)).not.toBeNull();
  expect(refusals()).toMatchObject([{ level: "error", reason: "no_workspaces" }]);
});

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
