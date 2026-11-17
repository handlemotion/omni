import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { members, users } from "../auth.ts";
import { createdAt, id, orgId, timestamptz } from "../columns.ts";
import { storageNodes } from "../storage.ts";

export const storageSignatureStatus = pgEnum("storage_signature_status", [
  "sent",
  "completed",
  "voided",
]);

export const storageSignatureEventKind = pgEnum("storage_signature_event_kind", [
  "sent",
  "viewed",
  "code_sent",
  "code_verified",
  "signed",
  "completed",
  "voided",
]);

/**
 * A stronger proof attached to a sealed copy (ADR 0037 decision 4): an RFC 3161 timestamp, or in
 * Mexico a NOM-151 conservation certificate. Optional; empty until a provider is configured.
 */
export interface StorageSignatureConservation {
  provider: string;
  timestamp: string;
  /** Base64 of the token or certificate the provider returned. */
  certificate: string;
}

/**
 * One file sent for signature. The file is locked while it is out, so its current content is the
 * content named here; changing it means voiding this and sending again.
 */
export const storageSignatureRequests = pgTable(
  "storage_signature_requests",
  {
    id: id(),
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    /** The file's `content_version` when it was sent. */
    contentVersion: integer("content_version").notNull(),
    /** Hex SHA-256 of the bytes sent, computed by the Worker as it streamed them. */
    documentSha256: text("document_sha256").notNull(),
    status: storageSignatureStatus("status").notNull().default("sent"),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    /** When the last signer signed and the copy was sealed. */
    completedAt: timestamptz("completed_at"),
    voidedAt: timestamptz("voided_at"),
    /** The sealed copy (the PDF with its audit page), stored beside the original and locked. */
    sealedNodeId: text("sealed_node_id").references(() => storageNodes.id, {
      onDelete: "set null",
    }),
    sealedSha256: text("sealed_sha256"),
    conservation: jsonb("conservation").$type<StorageSignatureConservation>(),
  },
  (t) => [
    unique("storage_signature_requests_id_org_id_unique").on(t.id, t.orgId),
    foreignKey({
      name: "storage_signature_requests_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    check(
      "storage_signature_requests_status_time",
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null) and (${t.status} = 'voided') = (${t.voidedAt} is not null)`,
    ),
    index("storage_signature_requests_node_id_idx").on(t.nodeId, t.createdAt),
    index("storage_signature_requests_sealed_node_id_idx").on(t.sealedNodeId),
    index("storage_signature_requests_created_by_member_id_idx").on(t.createdByMemberId),
  ],
);

/** A person asked to sign: an address, which need not have an account yet. */
export const storageSigners = pgTable(
  "storage_signers",
  {
    id: id(),
    orgId: orgId(),
    requestId: text("request_id").notNull(),
    /** Lowercase. */
    email: text("email").notNull(),
    /** The name the sender gave. */
    name: text("name").notNull(),
    signedAt: timestamptz("signed_at"),
    /** What the signer typed as their signature. */
    typedName: text("typed_name"),
    /** The version of the fixed consent sentence they accepted. */
    consentVersion: text("consent_version"),
    /** Hex SHA-256 of the bytes they were shown and signed. */
    documentSha256: text("document_sha256"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** The account that signed, with a session that verified this address. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    foreignKey({
      name: "storage_signers_request_org_fk",
      columns: [t.requestId, t.orgId],
      foreignColumns: [storageSignatureRequests.id, storageSignatureRequests.orgId],
    }).onDelete("cascade"),
    unique("storage_signers_request_id_email_unique").on(t.requestId, t.email),
    check(
      "storage_signers_signed",
      sql`(${t.signedAt} is null) = (${t.typedName} is null) and (${t.signedAt} is null) = (${t.consentVersion} is null) and (${t.signedAt} is null) = (${t.documentSha256} is null)`,
    ),
    index("storage_signers_email_idx").on(t.email),
    index("storage_signers_user_id_idx").on(t.userId),
  ],
);

/** The audit trail: append-only, one row per step, never updated. */
export const storageSignatureEvents = pgTable(
  "storage_signature_events",
  {
    id: id(),
    orgId: orgId(),
    requestId: text("request_id").notNull(),
    kind: storageSignatureEventKind("kind").notNull(),
    /** The address that acted: a signer, or the member who sent or voided. */
    email: text("email").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "storage_signature_events_request_org_fk",
      columns: [t.requestId, t.orgId],
      foreignColumns: [storageSignatureRequests.id, storageSignatureRequests.orgId],
    }).onDelete("cascade"),
    index("storage_signature_events_request_id_idx").on(t.requestId, t.createdAt, t.id),
  ],
);
