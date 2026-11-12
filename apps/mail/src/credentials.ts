// What `mailboxes.credentials_enc` decrypts to: the login and the servers to use it on. Hosts
// live inside the envelope so any IMAP/SMTP provider works without schema changes.
import { decryptCredential, encryptCredential, type Keyring } from "@omni/crypto";
import { z } from "zod";
import type { MailAuth, ServerEndpoint } from "./mailbox-connection.ts";
import { type GoogleOAuth, googleTokenSource } from "./providers/gmail.ts";

const endpoint = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
});

/** An app password (Purelymail, any IMAP host). */
const passwordSchema = z.object({
  user: z.string().min(1),
  pass: z.string().min(1),
  imap: endpoint,
  smtp: endpoint,
});

/** A Google account connected with OAuth (ADR 0023): logs in with XOAUTH2. */
const googleSchema = z.object({
  oauth: z.literal("google"),
  user: z.string().min(1),
  refreshToken: z.string().min(1),
  /** The access token the code exchange returned, so the first connect needs no refresh. */
  accessToken: z.string().min(1).optional(),
  /** When `accessToken` expires, in epoch milliseconds. */
  accessTokenExpiresAt: z.number().int().optional(),
  imap: endpoint,
  smtp: endpoint,
});

const credentialsSchema = z.union([googleSchema, passwordSchema]);

export interface PasswordCredentials {
  user: string;
  pass: string;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

export interface GoogleCredentials {
  oauth: "google";
  user: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

export type MailboxCredentials = PasswordCredentials | GoogleCredentials;

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

/** Google credentials need the OAuth client to refresh; without one they cannot log in. */
export class OAuthNotConfiguredError extends Error {
  override name = "OAuthNotConfiguredError";
}

/** How a mailbox with these credentials logs in to IMAP and SMTP. */
export function mailboxAuth(credentials: MailboxCredentials, google?: GoogleOAuth): MailAuth {
  if (!("oauth" in credentials)) return { kind: "password", pass: credentials.pass };
  if (!google) {
    throw new OAuthNotConfiguredError(
      "a Google mailbox needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
    );
  }
  return { kind: "oauth2", token: googleTokenSource(google, credentials) };
}
