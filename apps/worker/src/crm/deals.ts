import {
  crmCreateDealBodySchema,
  crmDealsQuerySchema,
  crmDeleteQuerySchema,
  crmUpdateDealBodySchema,
  type CrmDealDetailResponse,
  type CrmDealListResponse,
  type CrmDealResponse,
} from "@omni/contracts";
import type { CrmDeal } from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../context.ts";
import { imageHeaders } from "../image-proxy.ts";
import { MAX_PICTURE_BYTES, pictureUpload, sniffImageType } from "../routes/pictures.ts";
import { zValidator } from "../validator.ts";
import { lastContactedAt, subjectOf } from "./mail.ts";
import { capMax, requireCap } from "../billing.ts";
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

const iconKey = (orgId: string, dealId: string, iconId: string) =>
  `crm/deal-icons/${orgId}/${dealId}/${iconId}`;

async function iconChanged(
  c: Context<AppEnv>,
  changed: { deal: CrmDeal; replaced: string | null },
) {
  const { deal, replaced } = changed;
  if (replaced && replaced !== deal.iconId) {
    await c.env.MAIL_BUCKET.delete(iconKey(c.var.member.orgId, deal.id, replaced)).catch(
      (error: unknown) => console.error("deal icon cleanup failed", deal.id, error),
    );
  }
  await announce(c, "deal", [deal.id]);
  return c.json({ deal: wireDeal(deal) } satisfies CrmDealResponse);
}

async function storeIcon(c: Context<AppEnv>, dealId: string, file: File) {
  if (file.size > MAX_PICTURE_BYTES) {
    throw new HTTPException(413, { message: "the picture is larger than 2 MB" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new HTTPException(415, { message: "the picture must be a PNG, JPEG, WebP or GIF" });
  }
  const iconId = crypto.randomUUID();
  await c.env.MAIL_BUCKET.put(iconKey(c.var.member.orgId, dealId, iconId), bytes, {
    httpMetadata: { contentType },
  });
  return iconId;
}

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
    await requireCap(c.var.db, c.var.config, c.var.member.orgId, "crmRecords");
    const max = await capMax(c.var.db, c.var.config, c.var.member.orgId, "crmRecords");
    const made = await memberCrm(c).createDeal(c.req.valid("json"), max);
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

  .put("/deals/:id/icon", ...pictureUpload, async (c) => {
    const id = c.req.param("id");
    const found = await memberCrm(c).deal(id);
    if (found.status !== "ok") return refused(c, found);
    const iconId = await storeIcon(c, id, c.req.valid("form").file);
    const drop = () => c.env.MAIL_BUCKET.delete(iconKey(c.var.member.orgId, id, iconId));
    const changed = await memberCrm(c)
      .setDealIcon(id, iconId)
      .catch(async (error: unknown) => {
        await drop();
        throw error;
      });
    if (changed.status !== "ok") {
      await drop();
      return refused(c, changed);
    }
    return iconChanged(c, changed);
  })

  .delete("/deals/:id/icon", async (c) => {
    const changed = await memberCrm(c).setDealIcon(c.req.param("id"), null);
    if (changed.status !== "ok") return refused(c, changed);
    return iconChanged(c, changed);
  })

  .get("/deals/:id/icon/:iconId{[0-9a-f-]{36}}", async (c) => {
    const { id, iconId } = c.req.param();
    const found = await memberCrm(c).deal(id);
    if (found.status !== "ok") return refused(c, found);
    if (found.deal.iconId !== iconId) {
      throw new HTTPException(404, { message: "not found" });
    }
    const object = await c.env.MAIL_BUCKET.get(iconKey(c.var.member.orgId, id, iconId));
    if (!object) throw new HTTPException(404, { message: "not found" });
    return new Response(object.body, {
      headers: {
        ...imageHeaders(object.httpMetadata?.contentType ?? "application/octet-stream"),
        "content-length": String(object.size),
        etag: object.httpEtag,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
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
