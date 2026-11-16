// Creating one mailbox on a verified domain of the member's workspace, for onboarding and for the
// workspace admin routes (ADR 0017, ADR 0026). The caller decides its kind and who owns it; this
// checks the domain and the address, refuses to change whose an existing address is, and asks the
// mail service to provision it. The Worker never holds the mailbox's login beyond this request.
import {
  PROVISION_MAILBOX_PATH,
  provisionMailboxResultSchema,
  type ProvisionMailboxBody,
} from "@omni/contracts";
import { findMemberDomain, mailboxAtAddress, workspaceKind } from "@omni/db";
import { mailboxAddress } from "@omni/mail-core/domains";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./context.ts";
import { callMailService, MailServiceError } from "./mail-service.ts";

const server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().positive().max(65_535),
});

/** Where a new mailbox goes and, on an `imap` domain, the existing login it signs in with. */
export const mailboxPlacement = z.object({
  domainId: z.string().min(1),
  /** "rodrigo", or a full address on the domain. */
  localPart: z.string().trim().min(1).max(320),
  /** Only for an `imap` domain: an existing login on its mail host. */
  login: z
    .object({
      /** Defaults to the address. */
      user: z.string().trim().min(1).max(320).optional(),
      password: z.string().min(1).max(1024),
      imap: server,
      smtp: server,
    })
    .optional(),
});
export type MailboxPlacement = z.infer<typeof mailboxPlacement>;

/** 993 and 465 speak TLS from the first byte; any other port upgrades with STARTTLS if offered. */
const endpoint = (s: z.infer<typeof server>) => ({
  host: s.host,
  port: s.port,
  secure: s.port === 993 || s.port === 465,
});

export function fromMailService(error: unknown): never {
  if (error instanceof MailServiceError) {
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}

/** The verified domain and the full address a placement names, or an HTTP refusal. */
async function resolveAddress(c: Context<AppEnv>, placement: MailboxPlacement) {
  const setup = await findMemberDomain(c.var.db, c.var.member.id, placement.domainId);
  if (!setup) throw new HTTPException(404, { message: "no such domain" });
  const domain = setup.lock;
  if (!domain) {
    throw new HTTPException(409, {
      message: `${setup.claim?.domain ?? "This domain"} is not verified yet: add its _omni-challenge record and check again`,
    });
  }
  const address = mailboxAddress(placement.localPart, domain.domain);
  if (!address) {
    throw new HTTPException(400, {
      message: `use letters, digits, dots, dashes or underscores for a mailbox on ${domain.domain}`,
    });
  }
  return { domain, address };
}

/** The login the mail service provisions with: none on Omni's host, a checked one on `imap`. */
function loginFor(
  domain: { provider: string; domain: string; addedAt: Date | null },
  address: string,
  placement: MailboxPlacement,
): ProvisionMailboxBody["login"] {
  if (domain.provider === "purelymail") {
    if (placement.login)
      throw new HTTPException(400, { message: "This mailbox takes no password." });
    if (!domain.addedAt) {
      throw new HTTPException(409, {
        message: `Finish the DNS records for ${domain.domain} first.`,
      });
    }
    return { provider: "purelymail" };
  }
  if (domain.provider === "imap") {
    if (!placement.login)
      throw new HTTPException(400, { message: `Enter the password for ${address}.` });
    // Passed through to the mail service, which checks and encrypts it. Never stored or logged
    // here (ADR 0007).
    return {
      provider: "imap",
      user: placement.login.user ?? address,
      pass: placement.login.password,
      imap: endpoint(placement.login.imap),
      smtp: endpoint(placement.login.smtp),
    };
  }
  throw new HTTPException(409, { message: `${domain.provider} is not supported yet` });
}

/**
 * Provisions the mailbox, or returns the existing one at that address. `ownerMemberId` gets the
 * owner grant (for a shared mailbox, the first seat on its team). Idempotent per address. 409 when
 * the address is already a mailbox of the other kind, or someone else's personal inbox: provisioning
 * again keeps existing grants, so without this an inbox could change hands.
 */
export async function provisionMailbox(
  c: Context<AppEnv>,
  placement: MailboxPlacement,
  /** `ownerMemberId` null: a personal inbox waiting for an invitee, with no grant yet. */
  target: { kind: ProvisionMailboxBody["kind"] | "by-address"; ownerMemberId: string | null },
) {
  const { db, member, user } = c.var;
  const { domain, address } = await resolveAddress(c, placement);
  const login = loginFor(domain, address, placement);
  // Onboarding's rule (ADR 0007): the creator's own address is their personal inbox, the rest
  // (hello@, a teammate's before they join) are shared. A Personal space has only its owner, so
  // every address on its domain is theirs (ADR 0042).
  const kind =
    target.kind === "by-address"
      ? address === user.email.toLowerCase() ||
        (await workspaceKind(db, member.orgId)) === "personal"
        ? "personal"
        : "shared"
      : target.kind;
  const existing = await mailboxAtAddress(db, member.orgId, address);
  if (
    existing &&
    (existing.kind !== kind ||
      (kind === "personal" &&
        (target.ownerMemberId === null
          ? existing.memberIds.length > 0
          : !existing.memberIds.includes(target.ownerMemberId))))
  ) {
    throw new HTTPException(409, {
      message:
        existing.kind === "personal"
          ? `${address} is already someone's personal inbox`
          : `${address} is already a shared mailbox`,
    });
  }
  return callMailService(
    c.var,
    PROVISION_MAILBOX_PATH,
    {
      orgId: member.orgId,
      address,
      kind,
      ownerMemberId: target.ownerMemberId,
      login,
    } satisfies ProvisionMailboxBody,
    provisionMailboxResultSchema,
  ).catch(fromMailService);
}
