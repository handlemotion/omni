import { index, jsonb, pgEnum, pgTable, text, unique } from "drizzle-orm/pg-core";
import { members } from "./auth.ts";
import { id, orgId, timestamptz, createdAt, updatedAt } from "./columns.ts";
import { mailProvider } from "./mail/enums.ts";

/** A DNS record the provider asks for, with its last check. */
export interface MailDomainRecord {
  check: "ownership" | "mx" | "spf" | "dkim" | "dmarc";
  type: "TXT" | "MX" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  verified: boolean;
}

/**
 * A domain an org set up mailboxes on (ADR 0007). Unique across orgs: the first org to claim a
 * domain owns it, so no other org can create mailboxes on it through the provider API.
 */
export const mailDomains = pgTable(
  "mail_domains",
  {
    id: id(),
    orgId: orgId(),
    /** Normalized: lowercase punycode, no trailing dot. */
    domain: text("domain").notNull(),
    provider: mailProvider("provider").notNull(),
    /** Empty for `imap`: DNS belongs to the existing mail host. */
    dnsRecords: jsonb("dns_records").$type<MailDomainRecord[]>().notNull().default([]),
    /** When the provider accepted the domain (ownership proven). Set at claim for `imap`. */
    addedAt: timestamptz("added_at"),
    /** When every record last passed; null while any is waiting. */
    verifiedAt: timestamptz("verified_at"),
    checkedAt: timestamptz("checked_at"),
    /**
     * When a check last found Omni's challenge gone from DNS (ADR 0010). Set: sending from the
     * domain pauses; the lock stays. Cleared when the challenge verifies again.
     */
    dnsLostAt: timestamptz("dns_lost_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mail_domains_domain_unique").on(t.domain),
    index("mail_domains_org_id_idx").on(t.orgId),
  ],
);

/** One record's verdict at the last check (`@omni/mail-core/dns-diagnostics`). */
export interface DomainRecordDiagnostic {
  type: "TXT" | "MX" | "CNAME";
  name: string;
  status: string;
  message: string;
  found: string[];
  suggestion?: string;
}

/** What the last DNS check of a claim saw (ADR 0011), shown until the next one. */
export interface DomainCheck {
  checkedAt: string;
  zone: string | null;
  nameservers: string[];
  /** The DNS host, when its nameservers say which. */
  host: { id: string; name: string; steps: string; help: string } | null;
  /** The host's Domain Connect settings, when it offers the standard and our template. */
  domainConnect: {
    providerName: string;
    urlSyncUX: string;
    urlAPI: string;
    zone: string;
  } | null;
  challenge: DomainRecordDiagnostic | null;
  records: DomainRecordDiagnostic[];
}

export const domainClaimStatus = pgEnum("domain_claim_status", ["pending", "verified", "released"]);

/**
 * An org's claim on a domain (ADR 0010). Many orgs may hold a pending claim on one domain; the
 * first to publish its challenge in DNS locks the domain (its `mail_domains` row, with the same
 * id). Pending claims expire. One row per (org, domain): claiming again rotates the challenge.
 */
export const domainClaims = pgTable(
  "domain_claims",
  {
    id: id(),
    orgId: orgId(),
    /** Normalized like `mail_domains.domain`. */
    domain: text("domain").notNull(),
    status: domainClaimStatus("status").notNull().default("pending"),
    /** SHA-256 (hex) of the challenge TXT value. The value is shown once and never stored. */
    challengeHash: text("challenge_hash").notNull(),
    provider: mailProvider("provider").notNull(),
    /** The provider's records, so they can all be added with the challenge in one visit. */
    dnsRecords: jsonb("dns_records").$type<MailDomainRecord[]>().notNull().default([]),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** A pending claim past this is dead: it cannot verify, and it no longer counts to the cap. */
    expiresAt: timestamptz("expires_at").notNull(),
    verifiedAt: timestamptz("verified_at"),
    checkedAt: timestamptz("checked_at"),
    /** The last check's per-record verdicts and the DNS host it found. */
    lastCheck: jsonb("last_check").$type<DomainCheck>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("domain_claims_org_domain_unique").on(t.orgId, t.domain),
    index("domain_claims_domain_idx").on(t.domain),
  ],
);
