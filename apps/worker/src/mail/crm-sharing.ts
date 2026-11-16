// A mailbox's CRM activity sharing (ADR 0039 decision 2): `off`, `activity` (who corresponded
// with a client, and when) or `subjects` (and each thread's subject). A personal mailbox's owner
// sets it, and nobody else, admins included; a shared inbox's workspace owners and admins. The
// rule is decided at Mail's door (`forMember(...).crmSharing`); a write passes the read-only gate
// like any other. Mail has no client contract file, so the body is declared here.
import { CRM_SHARING_LEVELS, forMember, type CrmSharingResult } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";

/** `PUT /api/mail/mailboxes/:id/crm-sharing`; `GET` answers the same shape. */
const crmSharingBody = z.object({ level: z.enum(CRM_SHARING_LEVELS) });
export type CrmSharingBody = z.infer<typeof crmSharingBody>;

function answer(c: Context<AppEnv>, result: CrmSharingResult) {
  switch (result.status) {
    case "ok":
      return c.json({ level: result.level } satisfies CrmSharingBody);
    case "not_found":
      return apiError(c, "not_found", "mailbox not found");
    case "forbidden":
      return apiError(
        c,
        "forbidden",
        "a personal mailbox's owner sets its sharing; a shared inbox's, owners and admins",
      );
    case "no_crm":
      return apiError(c, "no_crm", "a Personal space has no CRM");
  }
}

export const mailCrmSharing = new Hono<AppEnv>()
  .get("/mailboxes/:id/crm-sharing", async (c) =>
    answer(c, await forMember(c.var.db, c.var.member.id).crmSharing(c.req.param("id"))),
  )
  .put("/mailboxes/:id/crm-sharing", zValidator("json", crmSharingBody), async (c) =>
    answer(
      c,
      await forMember(c.var.db, c.var.member.id).setCrmSharing(
        c.req.param("id"),
        c.req.valid("json").level,
      ),
    ),
  );
