// Onboarding (ADR 0007): what a new workspace has set up so far, claiming its domain (ADR 0010),
// and creating its mailboxes. The workspace itself is Better Auth's `organization.create`;
// invitations are Better Auth's too. Provider work (Purelymail, IMAP logins) and DNS lookups happen
// only in the mail service, which the Worker asks over the signed channel; the Worker never holds
// a mailbox credential.
import { zValidator } from "@hono/zod-validator";
import { mayCreateOrganization } from "@omni/auth";
import {
  PROVISION_MAILBOX_PATH,
  provisionMailboxResultSchema,
  type ProvisionMailboxBody,
} from "@omni/contracts";
import { newChallenge } from "@omni/crypto";
import {
  advanceOrgSetup,
  DOMAIN_ADMIN_ROLES,
  findMemberDomain,
  listDomainAudit,
  listMemberDomains,
  listMemberMailboxes,
  mailboxAtAddress,
  orgMember,
  orgSetupStep,
  releaseDomain,
  roleInOrg,
  rotateChallenge,
  schema,
  SETUP_STEPS,
  transferDomain,
  withdrawClaim,
} from "@omni/db";
import { mailboxAddress, parseDomain } from "@omni/mail-core/domains";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { inGoodStanding } from "../billing.ts";
import { requireMember, resolveSession, type AppEnv } from "../context.ts";
import {
  advanceDomainStep,
  audit,
  checkDomain,
  claimDomain,
  DomainError,
  type DomainDeps,
  domainView,
  notifyOwners,
  orgName,
  withCheck,
} from "../domains.ts";
import { domainConnectUrl } from "../dns-check.ts";
import { callMailService, MailServiceError } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";

const requireDomainAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!(DOMAIN_ADMIN_ROLES as readonly string[]).includes(c.var.member.role)) {
    throw new HTTPException(403, { message: "only owners and admins can set up mail" });
  }
  await next();
});

/** Releasing or moving a domain cannot be undone by the same workspace: owners only. */
const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.member.role !== "owner") {
    throw new HTTPException(403, { message: "only owners can release or move a domain" });
  }
  await next();
});

function fromMailService(error: unknown): never {
  if (error instanceof MailServiceError) {
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}

function deps(c: Context<AppEnv>): DomainDeps {
  return {
    db: c.var.db,
    config: c.var.config,
    requestId: c.var.requestId,
    log: c.var.log,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
}

/** Domain refusals become HTTP errors with their status. */
async function domainCall<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof DomainError)
      throw new HTTPException(error.status, { message: error.message });
    throw error;
  }
}

/**
 * Per org, so one workspace hammering its DNS cannot slow anyone else's. Workers Rate Limiting
 * is approximate per location, which is enough to stop loops and scripts.
 */
async function limit(c: Context<AppEnv>, limiter: RateLimit, what: string) {
  const { success } = await limiter.limit({ key: c.var.member.orgId });
  if (!success)
    throw new HTTPException(429, { message: `too many ${what}: wait a minute and try again` });
}

/** The member's org's domain by id, or 404. */
async function memberDomain(c: Context<AppEnv>) {
  const setup = await findMemberDomain(c.var.db, c.var.member.id, c.req.param("id") ?? "");
  if (!setup) throw new HTTPException(404, { message: "no such domain" });
  return setup;
}

/** Advances this org's setup step from the domain's view, then answers with that view. */
async function domainStep<V extends { verified: boolean }>(c: Context<AppEnv>, view: V) {
  await advanceDomainStep(c.var.db, c.var.member.orgId, view);
  return view;
}

const server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().positive().max(65_535),
});

const mailboxBody = z.object({
  domainId: z.string().min(1),
  /** "rodrigo", or a full address on the domain. */
  localPart: z.string().trim().min(1).max(320),
  /**
   * A member of this workspace to make it a personal inbox for: they get the owner grant, the
   * creator gets none. Without it the creator's own address is their personal inbox and any
   * other address is shared.
   */
  forMemberId: z.string().min(1).optional(),
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
    const canCreateOrganization = await mayCreateOrganization(db, user.id, config.auth.signUp);
    /** Billing is on for this deployment (ADR 0015): setup then has a plan step. */
    const billing = { enabled: config.auth.billing !== undefined };
    if (!member) {
      return c.json({
        canCreateOrganization,
        billing,
        organization: null,
        domains: [],
        mailboxes: [],
      });
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
      billing,
      organization: {
        id: member.orgId,
        name: org?.name ?? "",
        role: member.role,
        /** How far setup got; `/onboarding` resumes here. */
        setup: await orgSetupStep(db, member.orgId),
        /**
         * Billing is on and the workspace has no trial or plan in good standing. Read from the
         * subscription each time, not saved as a setup step, so it follows Stripe.
         */
        needsPlan: !(await inGoodStanding(db, config, member.orgId)),
      },
      domains: domains.map((setup) => domainView(setup)),
      mailboxes: mailboxes.map(({ id, address, kind, provider, status }) => ({
        id,
        address,
        kind,
        provider,
        status,
      })),
    });
  })
  /**
   * Claims a domain for the active org (ADR 0010): returns Omni's challenge record, shown this
   * once, and the provider's records, so all of them can go in at one visit to the DNS host.
   * Claiming a domain the org already claimed returns that claim, without a new challenge.
   */
  .post(
    "/domains",
    requireMember,
    requireDomainAdmin,
    zValidator("json", z.object({ domain: z.string().min(1).max(300) })),
    async (c) => {
      await limit(c, c.env.DOMAIN_ADD_LIMITER, "domains added");
      const parsed = parseDomain(c.req.valid("json").domain);
      if ("error" in parsed) throw new HTTPException(400, { message: parsed.error });
      const { claim, challengeValue } = await domainCall(() =>
        claimDomain(deps(c), c.var.member, parsed.domain),
      );
      const setup = (await findMemberDomain(c.var.db, c.var.member.id, claim.id)) ?? {
        claim,
        lock: null,
      };
      const url = await domainConnectUrl(deps(c), {
        check: claim.lastCheck,
        claimId: claim.id,
        domain: claim.domain,
        provider: claim.provider,
        challengeValue,
        records: claim.dnsRecords,
      });
      return c.json(
        await domainStep(c, domainView(setup, { challengeValue, domainConnectUrl: url })),
      );
    },
  )
  /**
   * Checks a domain's DNS: locks it to the org once its challenge is in, then re-checks the
   * provider's records (and adds it at the provider once its ownership record is in).
   */
  .post("/domains/:id/check", requireMember, requireDomainAdmin, async (c) => {
    await limit(c, c.env.DOMAIN_CHECK_LIMITER, "checks");
    const setup = await memberDomain(c);
    const result = await domainCall(() => checkDomain(deps(c), c.var.member, setup));
    return c.json(await domainStep(c, domainView(result.setup, { addError: result.addError })));
  })
  /**
   * A new challenge value, shown this once: for a member who lost the first one. The old value
   * stops counting, so a domain already verified reads as lost until DNS has the new one.
   */
  .post("/domains/:id/challenge", requireMember, requireDomainAdmin, async (c) => {
    await limit(c, c.env.DOMAIN_ADD_LIMITER, "new values");
    const setup = await memberDomain(c);
    if (!setup.claim) throw new HTTPException(409, { message: "this domain has no challenge" });
    const challenge = await newChallenge();
    const rotated = await rotateChallenge(c.var.db, {
      orgId: c.var.member.orgId,
      claimId: setup.claim.id,
      challengeHash: challenge.hash,
    });
    if (!rotated) throw new HTTPException(404, { message: "no such domain" });
    // What DNS holds now, judged against the new value (and the host's one-click setup).
    const claim = await withCheck(deps(c), rotated);
    await audit(
      c.var,
      c.var.member.orgId,
      c.var.member.id,
      "domain.challenge_rotated",
      claim.domain,
    );
    const url = await domainConnectUrl(deps(c), {
      check: claim.lastCheck,
      claimId: claim.id,
      domain: claim.domain,
      provider: claim.provider,
      challengeValue: challenge.value,
      records: setup.lock?.dnsRecords ?? claim.dnsRecords,
    });
    return c.json(
      domainView(
        { claim, lock: setup.lock },
        { challengeValue: challenge.value, domainConnectUrl: url },
      ),
    );
  })
  /**
   * Keeps the domain checked while its DNS page is open (ADR 0011): the page calls this when it
   * opens and about every minute, with `reset` when it comes back into focus. Results arrive as
   * `{ type: "domain", domainId }` on the realtime socket.
   */
  .post(
    "/domains/:id/watch",
    requireMember,
    requireDomainAdmin,
    zValidator("json", z.object({ reset: z.boolean().default(false) })),
    async (c) => {
      const setup = await memberDomain(c);
      if (!setup.claim) return c.json({ watching: false, nextCheckAt: null });
      const stub = c.env.DOMAIN_WATCH.get(c.env.DOMAIN_WATCH.idFromName(setup.claim.id));
      const { nextCheckAt } = await stub.watch({
        claimId: setup.claim.id,
        orgId: c.var.member.orgId,
        memberId: c.var.member.id,
        reset: c.req.valid("json").reset,
      });
      return c.json({ watching: true, nextCheckAt: new Date(nextCheckAt).toISOString() });
    },
  )
  /** The domain's history: claims, checks that changed something, hand-overs. */
  .get("/domains/:id/events", requireMember, requireDomainAdmin, async (c) => {
    const setup = await memberDomain(c);
    const domain = (setup.claim?.domain ?? setup.lock?.domain)!;
    const events = await listDomainAudit(c.var.db, c.var.member.id, domain);
    return c.json({
      events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    });
  })
  /**
   * Removes the domain from this workspace (ADR 0016). A claim that never verified is withdrawn
   * by an owner or admin: nothing was set up on it. A verified domain is released by an owner
   * only, and refused while this workspace has mailboxes on it; another workspace can then claim
   * it, and every owner is told. Neither deletes mail or touches the mail host.
   */
  .post("/domains/:id/release", requireMember, requireDomainAdmin, async (c) => {
    const { db, member, user } = c.var;
    const setup = await memberDomain(c);
    const domain = (setup.claim?.domain ?? setup.lock?.domain)!;
    if (!setup.lock) {
      const withdrawn = await withdrawClaim(db, { orgId: member.orgId, claimId: setup.claim!.id });
      if (!withdrawn) {
        throw new HTTPException(409, { message: `${domain} just verified: check it again` });
      }
      await audit(c.var, member.orgId, member.id, "domain.claim_withdrawn", domain);
      return c.json({ released: true });
    }
    if (member.role !== "owner") {
      throw new HTTPException(403, { message: "only owners can release or move a domain" });
    }
    const result = await releaseDomain(db, { orgId: member.orgId, domain });
    if (!result.ok) throw handOverRefusal(result.reason, domain);
    const eventId = await audit(c.var, member.orgId, member.id, "domain.released", domain);
    await notifyOwners(deps(c), member.orgId, eventId, {
      subject: `${domain} was released`,
      text: `${user.email} released ${domain} from ${await orgName(db, member.orgId)}. Any workspace that controls its DNS can now claim it.`,
    });
    return c.json({ released: true });
  })
  /**
   * Moves the domain to another workspace the caller also runs (owner or admin there), keeping
   * its verified challenge. Refused while this one has mailboxes on it. Owners of both are told.
   */
  .post(
    "/domains/:id/transfer",
    requireMember,
    requireOwner,
    zValidator("json", z.object({ organizationId: z.string().min(1) })),
    async (c) => {
      const { db, member, user } = c.var;
      const to = c.req.valid("json").organizationId;
      if (to === member.orgId) throw new HTTPException(400, { message: "that is this workspace" });
      const role = await roleInOrg(db, user.id, to);
      if (!role || !(DOMAIN_ADMIN_ROLES as readonly string[]).includes(role)) {
        throw new HTTPException(403, {
          message: "you can only move a domain to a workspace you own or administer",
        });
      }
      const setup = await memberDomain(c);
      const domain = (setup.claim?.domain ?? setup.lock?.domain)!;
      const result = await transferDomain(db, { fromOrgId: member.orgId, toOrgId: to, domain });
      if (!result.ok) throw handOverRefusal(result.reason, domain);
      const [fromName, toName] = await Promise.all([orgName(db, member.orgId), orgName(db, to)]);
      const text = `${user.email} moved ${domain} from ${fromName} to ${toName}.`;
      const subject = `${domain} moved to ${toName}`;
      const out = await audit(c.var, member.orgId, member.id, "domain.transferred_out", domain, {
        toOrgId: to,
      });
      const into = await audit(c.var, to, null, "domain.transferred_in", domain, {
        fromOrgId: member.orgId,
        byUserId: user.id,
      });
      await notifyOwners(deps(c), member.orgId, out, { subject, text });
      await notifyOwners(deps(c), to, into, { subject, text });
      return c.json({ transferred: true, organizationId: to });
    },
  )
  /**
   * Creates one mailbox on a domain of the active org and starts syncing it, during setup or
   * later from settings. The creator gets an owner grant, or with `forMemberId` that teammate
   * does (their personal inbox; ADR 0017). Idempotent per address: a repeat returns the same
   * mailbox. 409 when the address is a mailbox of another kind or owner.
   */
  .post(
    "/mailboxes",
    requireMember,
    requireDomainAdmin,
    limitPerMember("provision"),
    zValidator("json", mailboxBody),
    async (c) => {
      const { db, member, user } = c.var;
      const body = c.req.valid("json");
      const setup = await findMemberDomain(db, member.id, body.domainId);
      if (!setup) throw new HTTPException(404, { message: "no such domain" });
      const domain = setup.lock;
      if (!domain) {
        throw new HTTPException(409, {
          message: `${setup.claim!.domain} is not verified yet: add its _omni-challenge record and check again`,
        });
      }
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
            message: `Enter the password for ${address}.`,
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

      // For a teammate, named: their personal inbox, whatever its address. Otherwise the
      // creator's own address is their personal inbox; the rest (hello@, a teammate's before
      // they join) are shared, so read state stays per person (spec, sync rules).
      let owner = member.id;
      let kind: ProvisionMailboxBody["kind"] =
        address === user.email.toLowerCase() ? "personal" : "shared";
      if (body.forMemberId) {
        const teammate = await orgMember(db, member.orgId, body.forMemberId);
        if (!teammate) {
          throw new HTTPException(404, { message: "no such member in this workspace" });
        }
        owner = teammate.id;
        kind = "personal";
      }
      // Provisioning an address again replaces its login and keeps its grants, so it must not
      // change whose it is: a personal inbox never becomes shared or someone else's, and a
      // shared one never becomes a personal inbox its team could still read.
      const existing = await mailboxAtAddress(db, member.orgId, address);
      if (
        existing &&
        (existing.kind !== kind || (kind === "personal" && !existing.memberIds.includes(owner)))
      ) {
        throw new HTTPException(409, {
          message:
            existing.kind === "personal"
              ? `${address} is already someone's personal inbox`
              : `${address} is already a shared mailbox`,
        });
      }

      const result = await callMailService(
        c.var,
        PROVISION_MAILBOX_PATH,
        {
          orgId: member.orgId,
          address,
          kind,
          ownerMemberId: owner,
          login,
        } satisfies ProvisionMailboxBody,
        provisionMailboxResultSchema,
      ).catch(fromMailService);
      await advanceOrgSetup(db, member.orgId, "mailboxes_created");
      return c.json(result);
    },
  )
  /**
   * Finishes setup ("Finish setup" on the invite page, with or without invitations sent). Only
   * once a mailbox exists; repeating it is harmless.
   */
  .post("/complete", requireMember, requireDomainAdmin, async (c) => {
    const { db, member } = c.var;
    const step = await orgSetupStep(db, member.orgId);
    if (SETUP_STEPS.indexOf(step) < SETUP_STEPS.indexOf("mailboxes_created")) {
      throw new HTTPException(409, { message: "create a mailbox before finishing setup" });
    }
    if (!(await inGoodStanding(db, c.var.config, member.orgId))) {
      return c.json(
        {
          error: "start the free trial or choose a plan before finishing setup",
          code: "BILLING_REQUIRED",
        },
        402,
      );
    }
    return c.json({ setup: await advanceOrgSetup(db, member.orgId, "complete") });
  });

function handOverRefusal(reason: "not_locked" | "has_mailboxes", domain: string) {
  return new HTTPException(409, {
    message:
      reason === "has_mailboxes"
        ? `${domain} still has mailboxes in this workspace`
        : `${domain} is not set up by this workspace`,
  });
}
