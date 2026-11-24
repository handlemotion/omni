/** What the last complete sync saw. `highestModseq` is null when the server lacks CONDSTORE. */
export interface FolderPosition {
  highestModseq: bigint | null;
  uidNext: number;
}

/**
 * - `unchanged`: CONDSTORE says nothing moved; skip the folder.
 * - `condstore`: read flags changed since `changedSince`; list UIDs only if something was
 *   appended or expunged (the UID list is the only way to see expunges without QRESYNC).
 * - `uid-diff`: no CONDSTORE; list every UID and read every message's flags.
 */
export type FolderSyncPlan =
  | { mode: "unchanged" }
  | { mode: "condstore"; listUids: boolean; changedSince: bigint }
  | { mode: "uid-diff"; listUids: true; changedSince: undefined };

export const planFolderSync: (
  position: FolderPosition,
  server: { uidNext: number; exists: number; highestModseq: bigint | null },
  storedCount: number,
) => FolderSyncPlan = (position, server, storedCount) => {
  if (server.highestModseq === null || position.highestModseq === null) {
    return { mode: "uid-diff", listUids: true, changedSince: undefined };
  }
  const sameMessages = server.uidNext === position.uidNext && server.exists === storedCount;
  if (sameMessages && server.highestModseq === position.highestModseq) return { mode: "unchanged" };
  return { mode: "condstore", listUids: !sameMessages, changedSince: position.highestModseq };
};

const ROLE_BY_SPECIAL_USE = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Archive": "archive",
  "\\Trash": "trash",
  "\\Drafts": "drafts",
  "\\Junk": "junk",
} as const;

/** The part a folder plays in Wok; `other` is a folder Wok syncs but gives no meaning. */
export type ClassifiedRole =
  | (typeof ROLE_BY_SPECIAL_USE)[keyof typeof ROLE_BY_SPECIAL_USE]
  | "other";

/** A folder as an IMAP `LIST` names it: its path, flags and RFC 6154 special-use attribute. */
export interface ListedFolder {
  path: string;
  flags: ReadonlySet<string>;
  specialUse?: string | undefined;
}

/**
 * The selectable folders with their roles. A role goes to the first folder that claims it; later
 * ones are `other`. On Gmail (`X-GM-EXT-1`), All Mail is the archive and only folders with a role
 * are kept, since labels are not folders.
 */
export const classifyFolders: (
  listed: readonly ListedFolder[],
  options: { gmail: boolean },
) => { path: string; role: ClassifiedRole }[] = (listed, { gmail }) => {
  const taken = new Set<ClassifiedRole>();
  return listed
    .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
    .map((f) => {
      let role = roleOf(f, gmail);
      if (role !== "other" && taken.has(role)) role = "other";
      taken.add(role);
      return { path: f.path, role };
    })
    .filter((f) => !gmail || f.role !== "other");
};

const roleOf: (folder: ListedFolder, gmail: boolean) => ClassifiedRole = (folder, gmail) => {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  if (gmail && folder.specialUse === "\\All") return "archive";
  const special = folder.specialUse;
  return special !== undefined && Object.hasOwn(ROLE_BY_SPECIAL_USE, special)
    ? ROLE_BY_SPECIAL_USE[special as keyof typeof ROLE_BY_SPECIAL_USE]
    : "other";
};
