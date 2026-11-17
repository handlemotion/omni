import { afterAll, expect, test } from "vitest";
import { advanceOrgSetup, orgSetupStep } from "../src/workspaces.ts";
import { createMailbox, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

test("setup only moves forward, whatever order or how often steps report", async () => {
  const org = await createOrg(db, "setup-forward");
  expect(await orgSetupStep(db, org.id)).toBe("created");
  expect(await advanceOrgSetup(db, org.id, "domain_added")).toBe("domain_added");
  expect(await advanceOrgSetup(db, org.id, "mailboxes_created")).toBe("mailboxes_created");
  expect(await advanceOrgSetup(db, org.id, "domain_added")).toBe("mailboxes_created");
  expect(await advanceOrgSetup(db, org.id, "dns_verified")).toBe("mailboxes_created");
  await Promise.all([
    advanceOrgSetup(db, org.id, "complete"),
    advanceOrgSetup(db, org.id, "invites_sent"),
    advanceOrgSetup(db, org.id, "complete"),
  ]);
  expect(await orgSetupStep(db, org.id)).toBe("complete");
});

test("an invitation counts as the invite step only once mailboxes exist", async () => {
  const org = await createOrg(db, "setup-invite");
  expect(await advanceOrgSetup(db, org.id, "invites_sent", { onlyFrom: "mailboxes_created" })).toBe(
    "created",
  );
  await advanceOrgSetup(db, org.id, "domain_added");
  expect(await advanceOrgSetup(db, org.id, "invites_sent", { onlyFrom: "mailboxes_created" })).toBe(
    "domain_added",
  );
  await advanceOrgSetup(db, org.id, "mailboxes_created");
  expect(await advanceOrgSetup(db, org.id, "invites_sent", { onlyFrom: "mailboxes_created" })).toBe(
    "invites_sent",
  );
});

test("an org from before setup tracking is complete once it has a mailbox, and stays so", async () => {
  const org = await createOrg(db, "setup-legacy");
  await createMailbox(db, org.id, "hello@legacy.test");
  expect(await orgSetupStep(db, org.id)).toBe("complete");
  expect(await advanceOrgSetup(db, org.id, "domain_added")).toBe("complete");
});
