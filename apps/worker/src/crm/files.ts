import {
  crmLinkFilesBodySchema,
  type CrmFileLink as WireFileLink,
  type CrmFileLinksResponse,
} from "@omni/contracts";
import type { CrmFileLink, FileLinkRecord } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announce, memberCrm, refused } from "./http.ts";

const wireLink = ({ node, linkedAt, linkedByMemberId }: CrmFileLink) =>
  ({
    node: {
      ...node,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
      trashedAt: node.trashedAt?.toISOString() ?? null,
      lockedAt: node.lockedAt?.toISOString() ?? null,
    },
    linkedAt: linkedAt.toISOString(),
    linkedByMemberId,
  }) satisfies WireFileLink;

type Kind = "companies" | "deals";

const recordOf = (kind: Kind, id: string) =>
  (kind === "companies" ? { companyId: id } : { dealId: id }) satisfies FileLinkRecord;

const announced = (kind: Kind) => (kind === "companies" ? "company" : "deal");

async function list(c: Context<AppEnv>, kind: Kind, id: string) {
  const listed = await memberCrm(c).fileLinks(recordOf(kind, id));
  if (listed.status !== "ok") return refused(c, listed);
  return c.json({ links: listed.links.map(wireLink) } satisfies CrmFileLinksResponse);
}

const linkFilesBody = zValidator("json", crmLinkFilesBodySchema);

async function link(c: Context<AppEnv>, kind: Kind, id: string, nodeIds: string[]) {
  const linked = await memberCrm(c).linkFiles(recordOf(kind, id), nodeIds);
  if (linked.status !== "ok") return refused(c, linked);
  announce(c, announced(kind), [id]);
  return list(c, kind, id);
}

async function unlink(c: Context<AppEnv>, kind: Kind, id: string, nodeId: string) {
  const unlinked = await memberCrm(c).unlinkFile(recordOf(kind, id), nodeId);
  if (unlinked.status !== "ok") return refused(c, unlinked);
  if (unlinked.removed) announce(c, announced(kind), [id]);
  return c.body(null, 204);
}

/**
 * Drive files linked to a company or a deal where they live (`docs/spec/crm.md`, "Keep the files"). Linking moves and copies
 * nothing; the record's own uploads stay in its folder (`POST /:kind/:id/folder`).
 */
export const files = new Hono<AppEnv>()
  .get("/companies/:id/links", (c) => list(c, "companies", c.req.param("id")))
  .post("/companies/:id/links", linkFilesBody, (c) =>
    link(c, "companies", c.req.param("id"), c.req.valid("json").nodeIds),
  )
  .delete("/companies/:id/links/:nodeId", (c) =>
    unlink(c, "companies", c.req.param("id"), c.req.param("nodeId")),
  )
  .get("/deals/:id/links", (c) => list(c, "deals", c.req.param("id")))
  .post("/deals/:id/links", linkFilesBody, (c) =>
    link(c, "deals", c.req.param("id"), c.req.valid("json").nodeIds),
  )
  .delete("/deals/:id/links/:nodeId", (c) =>
    unlink(c, "deals", c.req.param("id"), c.req.param("nodeId")),
  );
