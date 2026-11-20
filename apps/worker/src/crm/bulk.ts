import { crmBulkBodySchema, type CrmBulkBody, type CrmBulkResponse } from "@omni/contracts";
import type { CrmBulkRecords } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiFailure } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { announce, memberCrm, refused, refusalCode } from "./http.ts";

const KIND = { companies: "company", people: "person", deals: "deal" } as const;

const runBulk = (records: CrmBulkRecords) => async (c: Context<AppEnv>, body: CrmBulkBody) => {
  const result = await memberCrm(c).bulk(records, body.ids, body.action);
  if (result.status === "no_crm") return refused(c, result);
  if (result.status === "invalid_action") {
    throw new ApiFailure("bad_request", `${records} cannot take ${body.action.action}`, {
      param: "action",
    });
  }
  await announce(c, KIND[records], result.done);
  return c.json({
    done: result.done,
    refused: result.refused.map(({ id, status }) => ({ id, code: refusalCode(status) })),
  } satisfies CrmBulkResponse);
};

const body = zValidator("json", crmBulkBodySchema);

export const bulk = new Hono<AppEnv>()
  .post("/companies/bulk", body, (c) => runBulk("companies")(c, c.req.valid("json")))
  .post("/people/bulk", body, (c) => runBulk("people")(c, c.req.valid("json")))
  .post("/deals/bulk", body, (c) => runBulk("deals")(c, c.req.valid("json")));
