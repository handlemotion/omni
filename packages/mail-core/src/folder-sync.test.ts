import { describe, expect, test } from "vitest";
import { classifyFolders, type ListedFolder, planFolderSync } from "./folder-sync.ts";

const synced = { highestModseq: 100n, uidNext: 51 };

describe("planFolderSync", () => {
  test("skips a folder only when mod-sequence, UIDNEXT and count all match", () => {
    expect(planFolderSync(synced, { uidNext: 51, exists: 50, highestModseq: 100n }, 50)).toEqual({
      mode: "unchanged",
    });
  });

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

const folder = (path: string, specialUse?: string, ...flags: string[]) =>
  ({ path, flags: new Set(flags), specialUse }) satisfies ListedFolder;

describe("classifyFolders", () => {
  const gmailList = [
    folder("INBOX", "\\Inbox"),
    folder("[Gmail]", undefined, "\\Noselect"),
    folder("[Gmail]/All Mail", "\\All"),
    folder("[Gmail]/Sent Mail", "\\Sent"),
    folder("[Gmail]/Spam", "\\Junk"),
    folder("[Gmail]/Trash", "\\Trash"),
    folder("[Gmail]/Starred", "\\Flagged"),
    folder("Receipts"),
  ];

  test("on Gmail, All Mail is the archive and labels are dropped, so mail is not indexed twice", () => {
    expect(classifyFolders(gmailList, { gmail: true })).toEqual([
      { path: "INBOX", role: "inbox" },
      { path: "[Gmail]/All Mail", role: "archive" },
      { path: "[Gmail]/Sent Mail", role: "sent" },
      { path: "[Gmail]/Spam", role: "junk" },
      { path: "[Gmail]/Trash", role: "trash" },
    ]);
  });

  test("off Gmail, an \\All folder is not the archive and plain folders are kept", () => {
    const roles = classifyFolders(gmailList, { gmail: false });
    expect(roles).toContainEqual({ path: "[Gmail]/All Mail", role: "other" });
    expect(roles).toContainEqual({ path: "Receipts", role: "other" });
  });

  test("a second folder claiming a role is other, so actions file into the first", () => {
    const roles = classifyFolders(
      [folder("INBOX"), folder("Sent", "\\Sent"), folder("Sent Items", "\\Sent")],
      { gmail: false },
    );
    expect(roles).toEqual([
      { path: "INBOX", role: "inbox" },
      { path: "Sent", role: "sent" },
      { path: "Sent Items", role: "other" },
    ]);
  });

  test("skips folders that cannot be selected and finds INBOX whatever its case", () => {
    const roles = classifyFolders(
      [
        folder("inbox"),
        folder("Gone", undefined, "\\NonExistent"),
        folder("Parent", undefined, "\\Noselect"),
      ],
      { gmail: false },
    );
    expect(roles).toEqual([{ path: "inbox", role: "inbox" }]);
  });
});
