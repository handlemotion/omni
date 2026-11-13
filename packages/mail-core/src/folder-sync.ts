// Deciding how much of an IMAP folder a sync must read, from the position stored after the last
// complete sync and what the server reports on SELECT. Pure, so the CONDSTORE shortcuts (which
// GreenMail, our e2e server, does not advertise) are tested here.

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

export function planFolderSync(
  position: FolderPosition,
  server: { uidNext: number; exists: number; highestModseq: bigint | null },
  storedCount: number,
): FolderSyncPlan {
  if (server.highestModseq === null || position.highestModseq === null) {
    return { mode: "uid-diff", listUids: true, changedSince: undefined };
  }
  const sameMessages = server.uidNext === position.uidNext && server.exists === storedCount;
  if (sameMessages && server.highestModseq === position.highestModseq) return { mode: "unchanged" };
  return { mode: "condstore", listUids: !sameMessages, changedSince: position.highestModseq };
}
