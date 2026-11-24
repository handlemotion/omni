import { classifyFolders } from "@omni/mail-core/folder-sync";
import type { ImapFlow } from "imapflow";
import type { FolderInfo } from "./ports.ts";

/** What an IMAP server offers: its capabilities, and its folders with the role each plays. */
export interface Capabilities {
  idle: boolean;
  condstore: boolean;
  uidplus: boolean;
  move: boolean;
  /**
   * The server speaks Gmail's IMAP extension (`X-GM-EXT-1`): system folders only, All Mail is the
   * archive, X-GM-THRID threads. A protocol signal, separate from the mailbox's stored provider
   * (`providerTraits`), which says what Wok promises the person.
   */
  gmail: boolean;
  /** Every capability the server advertised, logged on connect to show what a host supports. */
  all: string[];
}

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

/** The server's selectable folders with their roles (`classifyFolders` holds the rules). */
export async function listFolders(client: ImapFlow, gmail: boolean) {
  return classifyFolders(await client.list(), { gmail }) satisfies FolderInfo[];
}
