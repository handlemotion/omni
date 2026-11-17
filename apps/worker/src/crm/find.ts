import { crmLookupQuerySchema, crmSearchQuerySchema, type CrmFoundResponse } from "@omni/contracts";
import type { CrmCompany, CrmDeal, CrmPerson } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { memberCrm, refused, wireCompany, wireDeal, wirePerson } from "./http.ts";

const wireFound = (found: { people: CrmPerson[]; companies: CrmCompany[]; deals: CrmDeal[] }) =>
  ({
    people: found.people.map(wirePerson),
    companies: found.companies.map(wireCompany),
    deals: found.deals.map(wireDeal),
  }) satisfies CrmFoundResponse;

export const find = new Hono<AppEnv>()
  .get("/lookup", zValidator("query", crmLookupQuerySchema), async (c) => {
    const found = await memberCrm(c).lookup({ addresses: c.req.valid("query").address });
    if (found.status !== "ok") return refused(c, found);
    return c.json(wireFound(found));
  })

  .get("/search", zValidator("query", crmSearchQuerySchema), async (c) => {
    const found = await memberCrm(c).search(c.req.valid("query"));
    if (found.status !== "ok") return refused(c, found);
    return c.json(wireFound(found));
  });
