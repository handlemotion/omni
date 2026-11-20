import { z } from "zod";

const isoDate = z.iso.datetime();

/**
 * What a link does beyond who it opens for. None of it limits members or the people it is
 * shared with by address.
 */
export const storageLinkSchema = z.object({
  /** After this the link opens for nobody. */
  expiresAt: isoDate.nullable(),
  /** A visitor gives a password before the link opens (`POST /shared/:shareId/unlock`). */
  hasPassword: z.boolean(),
  /** False: view only. A visitor through the link sees the item and downloads nothing. */
  downloads: z.boolean(),
});

/**
 * A workspace's sharing policy (`GET /policy`; owners and admins `PUT` a change to either
 * field). `publicLinks` false: no link opens for anyone, and none can be set to; links open to
 * the workspace still work. `outsideSharing` false: nobody is invited by an address outside the
 * company (its claimed domains, or a member's own address).
 */
export const storagePolicySchema = z.object({
  publicLinks: z.boolean(),
  outsideSharing: z.boolean(),
});
export const storagePolicyResponseSchema = z.object({ policy: storagePolicySchema });
export const storageSetPolicyBodySchema = storagePolicySchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "change at least one setting" });

/** A link password: what a visitor types. */
export const storageLinkPasswordSchema = z.string().min(4).max(128);

/**
 * `POST /shared/:shareId/unlock`: the password of a link that answered `401 link_locked`.
 * Answers `{ key, expiresAt }` and sets the same key as a cookie scoped to the link, so the
 * browser's downloads carry it; a native client sends it as `x-omni-link-key`. A wrong password
 * is `403 wrong_password`, and tries are rate-limited.
 */
export const storageUnlockBodySchema = z.object({ password: z.string().min(1).max(128) });
export const storageUnlockResponseSchema = z.object({ key: z.string(), expiresAt: isoDate });
/** The header a native client sends an unlock key in. */
export const STORAGE_LINK_KEY_HEADER = "x-omni-link-key";

export type StorageLink = z.infer<typeof storageLinkSchema>;
export type StoragePolicy = z.infer<typeof storagePolicySchema>;
export type StoragePolicyResponse = z.infer<typeof storagePolicyResponseSchema>;
export type StorageUnlockResponse = z.infer<typeof storageUnlockResponseSchema>;
