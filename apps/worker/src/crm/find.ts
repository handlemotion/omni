// Finding records: `/api/crm/search` for pickers, `/api/crm/lookup` for a conversation's
// sidebar (the people, companies and open or won deals of its addresses). Every member sees
// every record (ADR 0036 decision 1), so neither leaks anything.
import { crmLookupQuerySchema, crmSearchQuerySchema, type CrmFoundResponse } from "@omni/contracts";
import type { CrmCompany, CrmDeal, CrmPerson } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { memberCrm, refused, wireCompany, wireDeal, wirePerson } from "./http.ts";

const wireFound = (found: {
  people: CrmPerson[];
  companies: CrmCompany[];
  deals: CrmDeal[];
}): CrmFoundResponse => ({
  people: found.people.map(wirePerson),
  companies: found.companies.map(wireCompany),
  deals: found.deals.map(wireDeal),
});

export const find = new Hono<AppEnv>()
  /** `?address=` repeated or comma separated, up to 50, in any letter case. */
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
