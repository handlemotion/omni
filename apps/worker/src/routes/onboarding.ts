// Onboarding (ADR 0007): what a new workspace has set up so far, adding its domain, and creating
// its mailboxes. The workspace itself is Better Auth's `organization.create`; invitations are
// Better Auth's too. Provider work (Purelymail, IMAP logins) happens only in the mail service,
// which the Worker asks over the signed channel; the Worker never holds a mailbox credential.
import { zValidator } from "@hono/zod-validator";
import { mayCreateOrganization } from "@omni/auth";
import {
  PROVISION_DOMAIN_PATH,
  PROVISION_MAILBOX_PATH,
  provisionDomainResultSchema,
  provisionMailboxResultSchema,
  type ProvisionMailboxBody,
} from "@omni/contracts";
import {
  DOMAIN_ADMIN_ROLES,
  findMemberDomain,
  listMemberDomains,
  listMemberMailboxes,
  mailDomainOwner,
  saveMailDomain,
  schema,
  type MailDomain,
} from "@omni/db";
import { eq } from "drizzle-orm";
import { mailboxAddress, normalizeDomain } from "@omni/mail-core/domains";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireMember, resolveSession, type AppEnv } from "../context.ts";
import { callMailService, MailServiceError } from "../mail-service.ts";

/** What the onboarding screen shows for a domain. */
function domainView(row: MailDomain, addError?: string) {
  return {
    id: row.id,
    domain: row.domain,
    /** `purelymail`: records to add below. `imap`: mailboxes are existing logins on your host. */
    provider: row.provider,
    records: row.dnsRecords,
    /** The provider accepted the domain, so mailboxes can be created on it. */
    added: row.addedAt !== null,
    /** Every record passed at the last check. */
    verified: row.verifiedAt !== null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    /** Why the provider would not add it yet, in its words (usually: no ownership record). */
    ...(addError ? { addError } : {}),
  };
}

const requireDomainAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!(DOMAIN_ADMIN_ROLES as readonly string[]).includes(c.var.member.role)) {
    throw new HTTPException(403, { message: "only owners and admins can set up mail" });
  }
  await next();
});

function fromMailService(error: unknown): never {
  if (error instanceof MailServiceError) {
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}

/** Adds the domain at the provider if needed, re-checks its DNS, and records the claim. */
async function refreshDomain(c: Context<AppEnv>, domain: string) {
  const { db, member } = c.var;
  const owner = await mailDomainOwner(db, domain);
  if (owner && owner !== member.orgId) {
    throw new HTTPException(409, { message: `${domain} is already set up by another workspace` });
  }
  const result = await callMailService(
    c.var,
    PROVISION_DOMAIN_PATH,
    { domain },
    provisionDomainResultSchema,
  ).catch(fromMailService);
  const records = result.provider === "purelymail" ? result.records : [];
  const row = await saveMailDomain(db, {
    orgId: member.orgId,
    domain,
    provider: result.provider,
    dnsRecords: records,
    // Without a provider API there is nothing to prove: the mail host already serves the domain.
    added: result.provider === "imap" || result.added,
    verified: result.provider === "imap" || (result.added && records.every((r) => r.verified)),
  });
  if (!row) {
    throw new HTTPException(409, { message: `${domain} is already set up by another workspace` });
  }
  return domainView(row, result.provider === "purelymail" ? result.addError : undefined);
}

const server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().positive().max(65_535),
});

const mailboxBody = z.object({
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

/** 993 and 465 speak TLS from the first byte; any other port upgrades with STARTTLS if offered. */
const endpoint = (s: z.infer<typeof server>) => ({
  host: s.host,
  port: s.port,
  secure: s.port === 993 || s.port === 465,
});

export const onboarding = new Hono<AppEnv>()
  /**
   * Where setup stands for the signed-in user. Works before they belong to any organization:
   * `organization` is null and `canCreateOrganization` says whether they may make one.
   */
  .get("/", async (c) => {
    const resolved = await resolveSession(c);
    if (!resolved) throw new HTTPException(401, { message: "sign in first" });
    const { db, config } = c.var;
    const { user, member } = resolved;
    const canCreateOrganization = await mayCreateOrganization(
      db,
      user.id,
      config.auth.organizationCreation,
    );
    if (!member) {
      return c.json({ canCreateOrganization, organization: null, domains: [], mailboxes: [] });
    }
    const [org] = await db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, member.orgId));
    const [domains, mailboxes] = await Promise.all([
      listMemberDomains(db, member.id),
      listMemberMailboxes(db, member.id),
    ]);
    return c.json({
      canCreateOrganization,
      organization: { id: member.orgId, name: org?.name ?? "", role: member.role },
      domains: domains.map((row) => domainView(row)),
      mailboxes: mailboxes.map(({ id, address, kind, provider, status }) => ({
        id,
        address,
        kind,
        provider,
        status,
      })),
    });
  })
  /** Claims a domain for the active org and returns the DNS records to add, each checked. */
  .post(
    "/domains",
    requireMember,
    requireDomainAdmin,
    zValidator("json", z.object({ domain: z.string().min(1).max(300) })),
    async (c) => {
      const domain = normalizeDomain(c.req.valid("json").domain);
      if (!domain) throw new HTTPException(400, { message: "that is not a domain name" });
      return c.json(await refreshDomain(c, domain));
    },
  )
  /** Re-checks a domain's DNS (and adds it at the provider once its ownership record is in). */
  .post("/domains/:id/check", requireMember, requireDomainAdmin, async (c) => {
    const row = await findMemberDomain(c.var.db, c.var.member.id, c.req.param("id"));
    if (!row) throw new HTTPException(404, { message: "no such domain" });
    return c.json(await refreshDomain(c, row.domain));
  })
  /**
   * Creates one mailbox on a domain of the active org and starts syncing it. The creator gets an
   * owner grant. Idempotent per address: a repeat returns the same mailbox.
   */
  .post(
    "/mailboxes",
    requireMember,
    requireDomainAdmin,
    zValidator("json", mailboxBody),
    async (c) => {
      const { db, member, user } = c.var;
      const body = c.req.valid("json");
      const domain = await findMemberDomain(db, member.id, body.domainId);
      if (!domain) throw new HTTPException(404, { message: "no such domain" });
      const address = mailboxAddress(body.localPart, domain.domain);
      if (!address) {
        throw new HTTPException(400, {
          message: `use letters, digits, dots, dashes or underscores for a mailbox on ${domain.domain}`,
        });
      }

      let login: ProvisionMailboxBody["login"];
      if (domain.provider === "purelymail") {
        if (body.login)
          throw new HTTPException(400, { message: "Purelymail mailboxes take no login" });
        if (!domain.addedAt) {
          throw new HTTPException(409, {
            message: `${domain.domain} is not on Purelymail yet: add its ownership record and check again`,
          });
        }
        login = { provider: "purelymail" };
      } else if (domain.provider === "imap") {
        if (!body.login) {
          throw new HTTPException(400, {
            message: "a mailbox on your own mail host needs its login",
          });
        }
        // Passed through to the mail service, which checks and encrypts it. Never stored or
        // logged here (ADR 0007).
        login = {
          provider: "imap",
          user: body.login.user ?? address,
          pass: body.login.password,
          imap: endpoint(body.login.imap),
          smtp: endpoint(body.login.smtp),
        };
      } else {
        throw new HTTPException(409, { message: `${domain.provider} is not supported yet` });
      }

      const result = await callMailService(
        c.var,
        PROVISION_MAILBOX_PATH,
        {
          orgId: member.orgId,
          address,
          // The creator's own address is their personal inbox; the rest (hello@, a teammate's
          // before they join) are shared, so read state stays per person (spec, sync rules).
          kind: address === user.email.toLowerCase() ? "personal" : "shared",
          ownerMemberId: member.id,
          login,
        } satisfies ProvisionMailboxBody,
        provisionMailboxResultSchema,
      ).catch(fromMailService);
      return c.json(result);
    },
  );
