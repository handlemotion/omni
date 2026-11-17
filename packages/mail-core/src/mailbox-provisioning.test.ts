import { describe, expect, test } from "vitest";
import { type MailboxProvisionFacts, planMailboxProvision } from "./mailbox-provisioning.ts";

const hosted: MailboxProvisionFacts = {
  domain: "acme.com",
  provider: "purelymail",
  claim: { provider: "purelymail", addedAt: new Date("2026-11-01") },
  hostConfigured: true,
  existing: null,
};

describe("planMailboxProvision", () => {
  test("refuses a domain the workspace has not claimed, or claimed for another provider", () => {
    expect(planMailboxProvision({ ...hosted, claim: null })).toEqual({
      kind: "refuse",
      message: "acme.com is not set up for this workspace",
    });
    expect(
      planMailboxProvision({ ...hosted, claim: { provider: "imap", addedAt: new Date() } }).kind,
    ).toBe("refuse");
    expect(
      planMailboxProvision({
        ...hosted,
        provider: "imap",
        claim: { provider: "purelymail", addedAt: new Date() },
      }).kind,
    ).toBe("refuse");
  });

  test("refuses a hosted mailbox before the host can take it", () => {
    expect(
      planMailboxProvision({ ...hosted, claim: { provider: "purelymail", addedAt: null } }),
    ).toEqual({
      kind: "refuse",
      message: "acme.com is not on Purelymail yet: add its ownership record",
    });
    expect(planMailboxProvision({ ...hosted, hostConfigured: false }).kind).toBe("refuse");
  });

  test("returns an existing hosted mailbox instead of issuing another login", () => {
    expect(
      planMailboxProvision({ ...hosted, existing: { id: "mb1", provider: "purelymail" } }),
    ).toEqual({ kind: "reuse", mailboxId: "mb1" });
  });

  test("replaces a mailbox of another kind in place", () => {
    expect(planMailboxProvision({ ...hosted, existing: { id: "mb1", provider: "imap" } })).toEqual({
      kind: "create",
      mailboxId: "mb1",
      sameLoginCheck: null,
    });
    const imap = {
      ...hosted,
      provider: "imap" as const,
      claim: { provider: "imap", addedAt: null },
    };
    expect(planMailboxProvision({ ...imap, existing: { id: "mb2", provider: "imap" } })).toEqual({
      kind: "create",
      mailboxId: "mb2",
      sameLoginCheck: "mb2",
    });
    expect(planMailboxProvision({ ...imap, existing: { id: "mb3", provider: "gmail" } })).toEqual({
      kind: "create",
      mailboxId: "mb3",
      sameLoginCheck: null,
    });
  });
});
