import {
  crmContractsQuerySchema,
  crmCreateContractBodySchema,
  crmSendContractBodySchema,
  crmUpdateContractBodySchema,
  type CrmContractListResponse,
  type CrmContractResponse,
  type CrmFolderResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { sendFileForSignature, voidSignatureRequest } from "../storage/signing.ts";
import { zValidator } from "../validator.ts";
import { announce, decodeCursor, encodeCursor, memberCrm, refused, wireContract } from "./http.ts";

const contractCursor = z.object({ at: z.iso.datetime(), id: z.string().min(1) });

export const contracts = new Hono<AppEnv>()
  .post("/companies/:id/folder", async (c) => {
    const id = c.req.param("id");
    const folder = await memberCrm(c).companyFolder(id);
    if (folder.status !== "ok") return refused(c, folder);
    if (folder.created) announce(c, "company", [id]);
    return c.json({ nodeId: folder.nodeId } satisfies CrmFolderResponse);
  })

  .post("/deals/:id/folder", async (c) => {
    const id = c.req.param("id");
    const folder = await memberCrm(c).dealFolder(id);
    if (folder.status !== "ok") return refused(c, folder);
    if (folder.created) {
      announce(c, "deal", [id]);
      announce(c, "company", [folder.companyId]);
    }
    return c.json({ nodeId: folder.nodeId } satisfies CrmFolderResponse);
  })

  .get("/contracts", zValidator("query", crmContractsQuerySchema), async (c) => {
    const { company, deal, cursor, limit } = c.req.valid("query");
    const decoded = decodeCursor(cursor, contractCursor);
    const page = {
      cursor: decoded && { createdAt: new Date(decoded.at), id: decoded.id },
      limit,
    };
    const listed = await memberCrm(c).listContracts(
      deal ? { dealId: deal, ...page } : { companyId: company!, ...page },
    );
    if (listed.status !== "ok") return refused(c, listed);
    const next = listed.nextCursor;
    return c.json({
      contracts: listed.contracts.map(wireContract),
      nextCursor: next ? encodeCursor({ at: next.createdAt.toISOString(), id: next.id }) : null,
    } satisfies CrmContractListResponse);
  })

  .post("/contracts", zValidator("json", crmCreateContractBodySchema), async (c) => {
    const made = await memberCrm(c).createContract(c.req.valid("json"));
    if (made.status !== "ok") return refused(c, made);
    announce(c, "contract", [made.contract.id]);
    return c.json({ contract: wireContract(made.contract) } satisfies CrmContractResponse, 201);
  })

  .patch("/contracts/:id", zValidator("json", crmUpdateContractBodySchema), async (c) => {
    const { signedAt, ...patch } = c.req.valid("json");
    const changed = await memberCrm(c).updateContract(c.req.param("id"), {
      ...patch,
      signedAt: signedAt === undefined ? undefined : new Date(signedAt),
    });
    if (changed.status !== "ok") return refused(c, changed);
    announce(c, "contract", [changed.contract.id]);
    return c.json({ contract: wireContract(changed.contract) } satisfies CrmContractResponse);
  })

  .post("/contracts/:id/send", zValidator("json", crmSendContractBodySchema), async (c) => {
    const id = c.req.param("id");
    const crm = memberCrm(c);
    const ready = await crm.contractToSend(id);
    if (ready.status !== "ok") return refused(c, ready);
    const sent = await sendFileForSignature(c, ready.documentNodeId, c.req.valid("json").signers);
    if (!sent.ok) return sent.response;
    const marked = await crm.markContractSent(id, sent.request);
    if (marked.status !== "ok") {
      await voidSignatureRequest(c, sent.request.id);
      return refused(c, marked);
    }
    announce(c, "contract", [id]);
    return c.json({ contract: wireContract(marked.contract) } satisfies CrmContractResponse);
  })

  .post("/contracts/:id/void", async (c) => {
    const id = c.req.param("id");
    const crm = memberCrm(c);
    const open = await crm.contractOpenRequest(id);
    if (open.status !== "ok") return refused(c, open);
    const voided = await voidSignatureRequest(c, open.requestId);
    if (voided.status === "not_found") return refused(c, voided);
    if (voided.status === "signature_closed") {
      return apiError(c, "signature_closed", "everyone signed or it was voided already");
    }
    const withdrawn = await crm.withdrawContract(id, open.requestId);
    if (withdrawn.status !== "ok") return refused(c, withdrawn);
    announce(c, "contract", [id]);
    return c.json({ contract: wireContract(withdrawn.contract) } satisfies CrmContractResponse);
  })

  .delete("/contracts/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await memberCrm(c).deleteContract(id);
    if (deleted.status !== "ok") return refused(c, deleted);
    announce(c, "contract", [id]);
    return c.body(null, 204);
  });
