import { mayCreateOrganization } from "@omni/auth";
import { newChallenge } from "@omni/crypto";
import {
  advanceOrgSetup,
  DOMAIN_ADMIN_ROLES,
  ensurePersonalSpace,
  findMemberDomain,
  listDomainAudit,
  listMemberDomains,
  listMemberMailboxes,
  orgSetupStep,
  releaseDomain,
  roleInOrg,
  rotateChallenge,
  schema,
  SETUP_STEPS,
  transferDomain,
  withdrawClaim,
  workspaceKind,
} from "@omni/db";
import { parseDomain } from "@omni/mail-core/domains";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { inGoodStanding } from "../billing.ts";
import { requireMember, resolveSession, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import {
  advanceDomainStep,
  audit,
  checkDomain,
  claimDomain,
  type DomainDeps,
  domainView,
  notifyOwners,
  orgName,
  withCheck,
} from "../domains.ts";
import { domainConnectUrl } from "../dns-check.ts";
import { mailboxPlacement, provisionMailbox } from "../provision-mailbox.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";

const requireDomainAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!(DOMAIN_ADMIN_ROLES as readonly string[]).includes(c.var.member.role)) {
    throw new HTTPException(403, { message: "only owners and admins can set up mail" });
  }
  await next();
});

const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.member.role !== "owner") {
    throw new HTTPException(403, { message: "only owners can release or move a domain" });
  }
  await next();
});

function deps(c: Context<AppEnv>) {
  return {
    db: c.var.db,
    config: c.var.config,
    requestId: c.var.requestId,
    log: c.var.log,
    email: c.env.EMAIL,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  } satisfies DomainDeps;
}

async function limit(c: Context<AppEnv>, limiter: RateLimit, what: string) {
  const { success } = await limiter.limit({ key: c.var.member.orgId });
  if (!success)
    throw new HTTPException(429, { message: `too many ${what}: wait a minute and try again` });
}

async function memberDomain(c: Context<AppEnv>) {
  const setup = await findMemberDomain(c.var.db, c.var.member.id, c.req.param("id") ?? "");
  if (!setup) throw new HTTPException(404, { message: "no such domain" });
  return setup;
}

async function domainStep<V extends { verified: boolean }>(c: Context<AppEnv>, view: V) {
  await advanceDomainStep(c.var.db, c.var.member.orgId, view);
  return view;
}

export const onboarding = new Hono<AppEnv>()
  .get("/", async (c) => {
    const resolved = await resolveSession(c);
    if (!resolved) throw new HTTPException(401, { message: "sign in first" });
    const { db, config } = c.var;
    const { user, member } = resolved;
    const canCreateOrganization =
      !user.scopeOrgId && (await mayCreateOrganization(db, user.id, config.auth.signUp));
    const billing = { enabled: config.auth.billing !== undefined };
    const [personal] = await db
      .select({ orgId: schema.personalSpaces.orgId })
      .from(schema.personalSpaces)
      .where(eq(schema.personalSpaces.userId, user.id));
    const canCreatePersonalSpace = !personal && !user.scopeOrgId;
    if (!member) {
      return c.json({
        canCreateOrganization,
        canCreatePersonalSpace,
        billing,
        organization: null,
        domains: [],
        mailboxes: [],
      });
    }
    const [domains, mailboxes] = await Promise.all([
      listMemberDomains(db, member.id),
      listMemberMailboxes(db, member.id),
    ]);
    const views = {
      domains: domains.map((setup) => domainView(setup)),
      mailboxes: mailboxes.map(({ id, address, kind, provider, status }) => ({
        id,
        address,
        kind,
        provider,
        status,
      })),
    };
    if ((await workspaceKind(db, member.orgId)) === "personal") {
      return c.json({
        canCreateOrganization,
        canCreatePersonalSpace,
        billing,
        organization: null,
        ...views,
      });
    }
    const [org] = await db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, member.orgId));
    return c.json({
      canCreateOrganization,
      canCreatePersonalSpace,
      billing,
      organization: {
        id: member.orgId,
        name: org?.name ?? "",
        role: member.role,
        setup: await orgSetupStep(db, member.orgId),
        needsPlan: !(await inGoodStanding(db, config, member.orgId)),
      },
      ...views,
    });
  })
  .post("/personal", async (c) => {
    const resolved = await resolveSession(c);
    if (!resolved) throw new HTTPException(401, { message: "sign in first" });
    if (resolved.user.scopeOrgId) {
      throw new HTTPException(403, {
        message: "signed in with a work address: sign in another way to use your own email",
      });
    }
    const orgId = await ensurePersonalSpace(c.var.db, resolved.user.id);
    const { headers } = await c.var.auth.api.setActiveOrganization({
      headers: c.req.raw.headers,
      body: { organizationId: orgId },
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    const [org] = await c.var.db
      .select({ slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    return c.json({ organization: { id: orgId, slug: org?.slug ?? "" } });
  })
  .post(
    "/domains",
    requireMember,
    requireDomainAdmin,
    zValidator(
      "json",
      z.object({
        domain: z.string().min(1).max(300),
        host: z.literal("gmail").optional(),
      }),
    ),
    async (c) => {
      await limit(c, c.env.DOMAIN_ADD_LIMITER, "domains added");
      const body = c.req.valid("json");
      const parsed = parseDomain(body.domain);
      if ("error" in parsed) throw new HTTPException(400, { message: parsed.error });
      const { claim, challengeValue } = await claimDomain(
        deps(c),
        c.var.member,
        parsed.domain,
        body.host,
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
  .post("/domains/:id/check", requireMember, requireDomainAdmin, async (c) => {
    await limit(c, c.env.DOMAIN_CHECK_LIMITER, "checks");
    const setup = await memberDomain(c);
    const result = await checkDomain(deps(c), c.var.member, setup);
    return c.json(await domainStep(c, domainView(result.setup, { addError: result.addError })));
  })
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
  .get("/domains/:id/events", requireMember, requireDomainAdmin, async (c) => {
    const setup = await memberDomain(c);
    const domain = (setup.claim?.domain ?? setup.lock?.domain)!;
    const events = await listDomainAudit(c.var.db, c.var.member.id, domain);
    return c.json({
      events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    });
  })
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
    await audit(c.var, member.orgId, member.id, "domain.released", domain);
    await notifyOwners(deps(c), member.orgId, {
      subject: `${domain} was released`,
      text: `${user.email} released ${domain} from ${await orgName(db, member.orgId)}. Any workspace that controls its DNS can now claim it.`,
    });
    return c.json({ released: true });
  })
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
      await audit(c.var, member.orgId, member.id, "domain.transferred_out", domain, {
        toOrgId: to,
      });
      await audit(c.var, to, null, "domain.transferred_in", domain, {
        fromOrgId: member.orgId,
        byUserId: user.id,
      });
      await notifyOwners(deps(c), member.orgId, { subject, text });
      await notifyOwners(deps(c), to, { subject, text });
      return c.json({ transferred: true, organizationId: to });
    },
  )
  .post(
    "/mailboxes",
    requireMember,
    requireDomainAdmin,
    limitPerMember("provision"),
    zValidator("json", mailboxPlacement),
    async (c) => {
      const { db, member } = c.var;
      const placement = c.req.valid("json");
      const target = { kind: "by-address" as const, ownerMemberId: member.id };
      const result = await provisionMailbox(c, placement, target);
      await advanceOrgSetup(db, member.orgId, "mailboxes_created");
      return c.json(result);
    },
  )
  .post("/complete", requireMember, requireDomainAdmin, async (c) => {
    const { db, member } = c.var;
    const step = await orgSetupStep(db, member.orgId);
    if (SETUP_STEPS.indexOf(step) < SETUP_STEPS.indexOf("mailboxes_created")) {
      throw new HTTPException(409, { message: "create a mailbox before finishing setup" });
    }
    if (!(await inGoodStanding(db, c.var.config, member.orgId))) {
      return apiError(
        c,
        "billing_required",
        "start the free trial or choose a plan before finishing setup",
      );
    }
    return c.json({ setup: await advanceOrgSetup(db, member.orgId, "complete") });
  });

const HAND_OVER_REFUSALS = {
  has_mailboxes: "still has mailboxes in this workspace",
  not_locked: "is not set up by this workspace",
  personal_space: "cannot move to a Personal space",
} as const;

function handOverRefusal(reason: keyof typeof HAND_OVER_REFUSALS, domain: string) {
  return new HTTPException(409, { message: `${domain} ${HAND_OVER_REFUSALS[reason]}` });
}
