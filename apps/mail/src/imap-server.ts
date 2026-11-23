import type { ImapFlow, ListResponse } from "imapflow";
import type { FolderInfo, FolderRole } from "./ports.ts";

/** What an IMAP server offers: its capabilities, and its folders with the role each plays. */
export interface Capabilities {
  idle: boolean;
  condstore: boolean;
  uidplus: boolean;
  move: boolean;
  /** Gmail (`X-GM-EXT-1`): system folders only, All Mail is the archive, X-GM-THRID threads. */
  gmail: boolean;
  /** Every capability the server advertised, logged on connect to show what a host supports. */
  all: string[];
}

const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Archive": "archive",
  "\\Trash": "trash",
  "\\Drafts": "drafts",
  "\\Junk": "junk",
};

export function detectCapabilities(client: ImapFlow) {
  const has = (name: string) => client.capabilities.has(name);
  return {
    idle: has("IDLE"),
    condstore: client.enabled.has("CONDSTORE") || has("CONDSTORE"),
    uidplus: has("UIDPLUS"),
    move: has("MOVE"),
    gmail: has("X-GM-EXT-1"),
    all: [...client.capabilities.keys()].toSorted(),
  } satisfies Capabilities;
}

/**
 * The selectable folders with their roles. A role goes to the first folder that claims it; later
 * ones are `other`. On Gmail, only folders with a role are kept (labels are not folders).
 */
export async function listFolders(client: ImapFlow, gmail: boolean) {
  const listed = await client.list();
  const taken = new Set<FolderRole>();
  return listed
    .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
    .map((f) => {
      let role = roleOf(f, gmail);
      if (role !== "other" && taken.has(role)) role = "other";
      taken.add(role);
      return { path: f.path, role };
    })
    .filter((f) => !gmail || f.role !== "other") satisfies FolderInfo[];
}

const roleOf: (folder: ListResponse, gmail: boolean) => FolderRole = (folder, gmail) => {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  if (gmail && folder.specialUse === "\\All") return "archive";
  return (folder.specialUse && ROLE_BY_SPECIAL_USE[folder.specialUse]) || "other";
};
