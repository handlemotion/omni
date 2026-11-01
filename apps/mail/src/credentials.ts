// What `mailboxes.credentials_enc` decrypts to: the login and the servers to use it on. Hosts
// live inside the envelope so any IMAP/SMTP provider works without schema changes.
import { decryptCredential, encryptCredential, type Keyring } from "@omni/crypto";
import { z } from "zod";
import type { ServerEndpoint } from "./mailbox-connection.ts";

const endpoint = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
});

const credentialsSchema = z.object({
  user: z.string().min(1),
  pass: z.string().min(1),
  imap: endpoint,
  smtp: endpoint,
});

export interface MailboxCredentials {
  user: string;
  pass: string;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

/** The ciphertext is bound to `mailboxId`: copied to another row, it fails to decrypt. */
export function sealCredentials(
  keyring: Keyring,
  mailboxId: string,
  credentials: MailboxCredentials,
): Promise<string> {
  return encryptCredential(
    keyring,
    JSON.stringify(credentialsSchema.parse(credentials)),
    mailboxId,
  );
}

export async function openCredentials(
  keyring: Keyring,
  mailboxId: string,
  envelope: string,
): Promise<MailboxCredentials> {
  return credentialsSchema.parse(JSON.parse(await decryptCredential(keyring, envelope, mailboxId)));
}
