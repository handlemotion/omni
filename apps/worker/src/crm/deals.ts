import {
  crmCreateDealBodySchema,
  crmDealsQuerySchema,
  crmDeleteQuerySchema,
  crmUpdateDealBodySchema,
  type CrmDealDetailResponse,
  type CrmDealListResponse,
  type CrmDealResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { lastContactedAt, subjectOf } from "./mail.ts";
import {
  announce,
  encodeCursor,
  listInput,
  memberCrm,
  refused,
  wireContract,
  wireDeal,
  wirePerson,
} from "./http.ts";

export const deals = new Hono<AppEnv>()
  .get("/deals", zValidator("query", crmDealsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const listed = await memberCrm(c).listDeals({
      ...listInput(query),
      stageId: query.stage,
      kind: query.kind,
      companyId: query.company,
      closeAfter: query.closeAfter,
      closeBefore: query.closeBefore,
      minValue: query.minValue,
      maxValue: query.maxValue,
    });
    if (listed.status !== "ok") return refused(c, listed);
    return c.json({
      deals: listed.deals.map(wireDeal),
      nextCursor: encodeCursor(listed.nextCursor),
    } satisfies CrmDealListResponse);
  })

  .post("/deals", zValidator("json", crmCreateDealBodySchema), async (c) => {
    const made = await memberCrm(c).createDeal(c.req.valid("json"));
    if (made.status !== "ok") return refused(c, made);
    await announce(c, "deal", [made.deal.id]);
    return c.json({ deal: wireDeal(made.deal) } satisfies CrmDealResponse, 201);
  })

  .get("/deals/:id", async (c) => {
    const id = c.req.param("id");
    const crm = memberCrm(c);
    const [found, contracts] = await Promise.all([crm.deal(id), crm.listContracts({ dealId: id })]);
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      deal: wireDeal(found.deal),
      people: found.people.map(wirePerson),
      contracts: contracts.status === "ok" ? contracts.contracts.map(wireContract) : [],
      lastContactedAt: await lastContactedAt(c, subjectOf(found.people)),
    } satisfies CrmDealDetailResponse);
  })

  .patch("/deals/:id", zValidator("json", crmUpdateDealBodySchema), async (c) => {
    const changed = await memberCrm(c).updateDeal(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    await announce(c, "deal", [changed.deal.id]);
    return c.json({ deal: wireDeal(changed.deal) } satisfies CrmDealResponse);
  })

  .post("/deals/:id/restore", async (c) => {
    const restored = await memberCrm(c).restoreDeal(c.req.param("id"));
    if (restored.status !== "ok") return refused(c, restored);
    await announce(c, "deal", [restored.deal.id]);
    return c.json({ deal: wireDeal(restored.deal) } satisfies CrmDealResponse);
  })

  .delete("/deals/:id", zValidator("query", crmDeleteQuerySchema), async (c) => {
    const id = c.req.param("id");
    const crm = memberCrm(c);
    if (c.req.valid("query").forever) {
      const deleted = await crm.deleteDeal(id);
      if (deleted.status !== "ok") return refused(c, deleted);
      await announce(c, "deal", [id]);
      return c.body(null, 204);
    }
    const archived = await crm.archiveDeal(id);
    if (archived.status !== "ok") return refused(c, archived);
    await announce(c, "deal", [id]);
    return c.json({ deal: wireDeal(archived.deal) } satisfies CrmDealResponse);
  });
