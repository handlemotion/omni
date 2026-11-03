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
  // A retried domain request, or a DNS check that now fails, after mailboxes exist.
  expect(await advanceOrgSetup(db, org.id, "domain_added")).toBe("mailboxes_created");
  expect(await advanceOrgSetup(db, org.id, "dns_verified")).toBe("mailboxes_created");
  // Concurrent repeats settle on the furthest step.
  await Promise.all([
    advanceOrgSetup(db, org.id, "complete"),
    advanceOrgSetup(db, org.id, "invites_sent"),
    advanceOrgSetup(db, org.id, "complete"),
  ]);
  expect(await orgSetupStep(db, org.id)).toBe("complete");
});

test("an invitation counts as the invite step only once mailboxes exist", async () => {
  const org = await createOrg(db, "setup-invite");
  // An invitation sent from settings mid-setup must not skip the domain and mailbox steps.
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
  // `org:create` plus `mailbox:add`: no setup row. Its members must not be sent to onboarding.
  const org = await createOrg(db, "setup-legacy");
  await createMailbox(db, org.id, "hello@legacy.test");
  expect(await orgSetupStep(db, org.id)).toBe("complete");
  // Adding another domain later through onboarding's routes does not reopen setup.
  expect(await advanceOrgSetup(db, org.id, "domain_added")).toBe("complete");
});
