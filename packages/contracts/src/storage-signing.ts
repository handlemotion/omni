import { z } from "zod";
import { storageEmailSchema } from "./storage-links.ts";

const isoDate = z.iso.datetime();

/**
 * The sentence a signer accepts, with its version. A signer sends the version back; one that is
 * not the current version answers `409 consent_changed`, so nobody signs under words they did not
 * see. Changing the words means a new version.
 */
export const STORAGE_SIGNING_CONSENT = {
  version: "2026-11-16",
  text: "I agree to sign this document electronically, and that my typed name is my signature on it.",
} as const;

export const storageSignatureStatusSchema = z.enum(["sent", "completed", "voided"]);

/**
 * `POST /files/:id/signatures`: sends a PDF the member reaches to these addresses, in this order.
 * The Worker hashes the bytes, locks the file and mails each signer a link. Answers
 * `201 { request }`; `415 not_a_pdf`, `409 signature_open` while another request is out on it.
 */
export const storageSendForSignatureBodySchema = z.object({
  signers: z
    .array(z.object({ email: storageEmailSchema, name: z.string().trim().min(1).max(200) }))
    .min(1)
    .max(20)
    .refine((list) => new Set(list.map((s) => s.email)).size === list.length, {
      message: "each address signs once",
    }),
});

const storageSignatureEventSchema = z.object({
  kind: z.enum(["sent", "viewed", "code_sent", "code_verified", "signed", "completed", "voided"]),
  email: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: isoDate,
});

/** A request as its sender sees it: every signer and the whole audit trail. */
export const storageSignatureRequestSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  contentVersion: z.number().int(),
  /** Hex SHA-256 of the bytes sent, computed by the Worker. */
  documentSha256: z.string(),
  status: storageSignatureStatusSchema,
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  voidedAt: isoDate.nullable(),
  /** The signed copy (the PDF with its audit page), a locked file beside the original. */
  sealedNodeId: z.string().nullable(),
  sealedSha256: z.string().nullable(),
  signers: z.array(
    z.object({
      email: z.string(),
      name: z.string(),
      signedAt: isoDate.nullable(),
      typedName: z.string().nullable(),
    }),
  ),
  events: z.array(storageSignatureEventSchema),
});

/** `POST /files/:id/signatures` and `POST /signatures/:requestId/void` answer this. */
export const storageSignatureRequestResponseSchema = z.object({
  request: storageSignatureRequestSchema,
});

/** `GET /files/:id/signatures`: every request made on the file, newest first. */
export const storageSignatureRequestsResponseSchema = z.object({
  requests: z.array(storageSignatureRequestSchema),
});

/**
 * A request as a person asked to sign it sees it, under `/api/storage/signing`: the others by
 * name only. `GET /signing` lists them, `GET /signing/:id` is one, `GET /signing/:id/content` is
 * the document, `POST /signing/:id/code` mails a one-time code and `POST /signing/:id/sign` signs.
 */
export const storageSigningItemSchema = z.object({
  id: z.string(),
  status: storageSignatureStatusSchema,
  fileName: z.string(),
  size: z.number().int(),
  workspaceName: z.string(),
  sentBy: z.string().nullable(),
  createdAt: isoDate,
  documentSha256: z.string(),
  /** The signed copy is ready at `GET /signing/:id/sealed`. */
  sealed: z.boolean(),
  signers: z.array(z.object({ name: z.string(), signed: z.boolean() })),
  me: z.object({ email: z.string(), name: z.string(), signedAt: isoDate.nullable() }),
});

export const storageSigningListResponseSchema = z.object({
  items: z.array(storageSigningItemSchema),
});

/** One request, with the consent sentence a signer accepts (`STORAGE_SIGNING_CONSENT`). */
export const storageSigningItemResponseSchema = z.object({
  item: storageSigningItemSchema,
  consent: z.object({ version: z.string(), text: z.string() }),
});

/** `POST /signing/:id/code` answers when the code mailed stops working. */
export const storageSigningCodeResponseSchema = z.object({ expiresAt: isoDate });

/** `POST /signing/:id/sign`. A wrong or expired code is `400 invalid_code`. */
export const storageSignBodySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  typedName: z.string().trim().min(1).max(200),
  consentVersion: z.string(),
});

/**
 * `?signer=` on `POST /signing/:id/code` and `/sign`: the address the page shows. When the
 * browser now opens the request as someone else, the call answers `409 signer_changed`.
 */
export const storageSignerQuerySchema = z.object({ signer: z.string().max(320).optional() });

/** `POST /api/storage/signing/:id/link`: the token from the signing mail's link. */
export const storageSigningLinkBodySchema = z.object({ token: z.string().min(20).max(200) });

export type StorageSignatureStatus = z.infer<typeof storageSignatureStatusSchema>;
export type StorageSendForSignatureBody = z.infer<typeof storageSendForSignatureBodySchema>;
export type StorageSignatureRequest = z.infer<typeof storageSignatureRequestSchema>;
export type StorageSignatureRequestResponse = z.infer<typeof storageSignatureRequestResponseSchema>;
export type StorageSignatureRequestsResponse = z.infer<
  typeof storageSignatureRequestsResponseSchema
>;
export type StorageSigningItem = z.infer<typeof storageSigningItemSchema>;
export type StorageSigningListResponse = z.infer<typeof storageSigningListResponseSchema>;
export type StorageSigningItemResponse = z.infer<typeof storageSigningItemResponseSchema>;
export type StorageSigningCodeResponse = z.infer<typeof storageSigningCodeResponseSchema>;
export type StorageSignBody = z.infer<typeof storageSignBodySchema>;
