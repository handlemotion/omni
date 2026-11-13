import { describe, expect, test } from "vitest";
import { planFolderSync } from "./folder-sync.ts";

const synced = { highestModseq: 100n, uidNext: 51 };

describe("planFolderSync", () => {
  test("skips a folder only when mod-sequence, UIDNEXT and count all match", () => {
    expect(planFolderSync(synced, { uidNext: 51, exists: 50, highestModseq: 100n }, 50)).toEqual({
      mode: "unchanged",
    });
  });

  // An expunge on another client lowers EXISTS but keeps UIDNEXT; skipping the UID list here
  // would leave the deleted message in Omni forever.
  test("lists UIDs when a message was expunged elsewhere, even with UIDNEXT unchanged", () => {
    const plan = planFolderSync(synced, { uidNext: 51, exists: 49, highestModseq: 101n }, 50);
    expect(plan).toEqual({ mode: "condstore", listUids: true, changedSince: 100n });
  });

  test("lists UIDs when new mail arrived", () => {
    const plan = planFolderSync(synced, { uidNext: 52, exists: 51, highestModseq: 101n }, 50);
    expect(plan).toMatchObject({ mode: "condstore", listUids: true });
  });

  test("reads only changed flags, without listing UIDs, when only flags changed", () => {
    const plan = planFolderSync(synced, { uidNext: 51, exists: 50, highestModseq: 107n }, 50);
    expect(plan).toEqual({ mode: "condstore", listUids: false, changedSince: 100n });
  });

  // A store that lost rows (failed imports) has fewer than EXISTS: re-list to retry them.
  test("lists UIDs when the stored count is behind the server", () => {
    const plan = planFolderSync(synced, { uidNext: 51, exists: 50, highestModseq: 100n }, 48);
    expect(plan).toMatchObject({ mode: "condstore", listUids: true });
  });

  test("falls back to a full UID diff without CONDSTORE on either side", () => {
    const first = { highestModseq: null, uidNext: 0 };
    expect(planFolderSync(first, { uidNext: 51, exists: 50, highestModseq: 100n }, 0).mode).toBe(
      "uid-diff",
    );
    expect(planFolderSync(synced, { uidNext: 51, exists: 50, highestModseq: null }, 50).mode).toBe(
      "uid-diff",
    );
  });
});
