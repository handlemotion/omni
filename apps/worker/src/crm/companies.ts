import {
  crmCompaniesQuerySchema,
  crmCreateCompanyBodySchema,
  crmDeleteQuerySchema,
  crmUpdateCompanyBodySchema,
  type CrmCompanyDetailResponse,
  type CrmCompanyListResponse,
  type CrmCompanyResponse,
  type CrmDomainsResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { lastContactedAt, subjectOf } from "./mail.ts";
import { capMax, requireCap } from "../billing.ts";
import {
  announce,
  encodeCursor,
  listInput,
  memberCrm,
  refused,
  wireCompany,
  wireDeal,
  wirePerson,
} from "./http.ts";

export const companies = new Hono<AppEnv>()
  .get("/companies", zValidator("query", crmCompaniesQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const listed = await memberCrm(c).listCompanies({
      ...listInput(query),
      domain: query.domain,
    });
    if (listed.status !== "ok") return refused(c, listed);
    return c.json({
      companies: listed.companies.map(wireCompany),
      nextCursor: encodeCursor(listed.nextCursor),
    } satisfies CrmCompanyListResponse);
  })

  .post("/companies", zValidator("json", crmCreateCompanyBodySchema), async (c) => {
    await requireCap(c.var.db, c.var.config, c.var.member.orgId, "crmRecords");
    const max = await capMax(c.var.db, c.var.config, c.var.member.orgId, "crmRecords");
    const made = await memberCrm(c).createCompany(c.req.valid("json"), max);
    if (made.status !== "ok") return refused(c, made);
    await announce(c, "company", [made.company.id]);
    return c.json({ company: wireCompany(made.company) } satisfies CrmCompanyResponse, 201);
  })

  .get("/companies/:id", async (c) => {
    const found = await memberCrm(c).company(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      company: wireCompany(found.company),
      domains: found.domains,
      people: found.people.map(wirePerson),
      deals: found.deals.map(wireDeal),
      lastContactedAt: await lastContactedAt(c, subjectOf(found.people, found.domains)),
    } satisfies CrmCompanyDetailResponse);
  })

  .patch("/companies/:id", zValidator("json", crmUpdateCompanyBodySchema), async (c) => {
    const changed = await memberCrm(c).updateCompany(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    await announce(c, "company", [changed.company.id]);
    return c.json({ company: wireCompany(changed.company) } satisfies CrmCompanyResponse);
  })

  .delete("/companies/:id", zValidator("query", crmDeleteQuerySchema), async (c) => {
    const id = c.req.param("id");
    const crm = memberCrm(c);
    if (c.req.valid("query").forever) {
      const deleted = await crm.deleteCompany(id);
      if (deleted.status !== "ok") return refused(c, deleted);
      await announce(c, "company", [id]);
      return c.body(null, 204);
    }
    const archived = await crm.archiveCompany(id);
    if (archived.status !== "ok") return refused(c, archived);
    await announce(c, "company", [id]);
    return c.json({ company: wireCompany(archived.company) } satisfies CrmCompanyResponse);
  })

  .post("/companies/:id/restore", async (c) => {
    const restored = await memberCrm(c).restoreCompany(c.req.param("id"));
    if (restored.status !== "ok") return refused(c, restored);
    await announce(c, "company", [restored.company.id]);
    return c.json({ company: wireCompany(restored.company) } satisfies CrmCompanyResponse);
  })

  .put("/companies/:id/domains/:domain", async (c) => {
    const id = c.req.param("id");
    const added = await memberCrm(c).addCompanyDomain(id, c.req.param("domain"));
    if (added.status !== "ok") return refused(c, added);
    await announce(c, "company", [id]);
    return c.json({ domains: added.domains } satisfies CrmDomainsResponse);
  })

  .delete("/companies/:id/domains/:domain", async (c) => {
    const id = c.req.param("id");
    const removed = await memberCrm(c).removeCompanyDomain(id, c.req.param("domain"));
    if (removed.status !== "ok") return refused(c, removed);
    await announce(c, "company", [id]);
    return c.json({ domains: removed.domains } satisfies CrmDomainsResponse);
  });
