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
  // Creating a user is a write on the deployment's shared Purelymail account: a workspace must
  // never get one on a domain it does not hold, or on one set up for another provider.
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

  // Purelymail refuses users on a domain it has not accepted, with a reason the member cannot act
  // on; and without the API token there is no host to create them on at all.
  test("refuses a hosted mailbox before the host can take it", () => {
    expect(
      planMailboxProvision({ ...hosted, claim: { provider: "purelymail", addedAt: null } }),
    ).toEqual({
      kind: "refuse",
      message: "acme.com is not on Purelymail yet: add its ownership record",
    });
    expect(planMailboxProvision({ ...hosted, hostConfigured: false }).kind).toBe("refuse");
  });

  // A double submit or a retried request would otherwise issue a second app password, one more
  // live secret on the account that nothing stores or revokes.
  test("returns an existing hosted mailbox instead of issuing another login", () => {
    expect(
      planMailboxProvision({ ...hosted, existing: { id: "mb1", provider: "purelymail" } }),
    ).toEqual({ kind: "reuse", mailboxId: "mb1" });
  });

  // Moving an address onto hosted mail (or onto a new IMAP login) keeps its row, so its threads
  // and grants stay; only an IMAP row is compared login for login.
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
