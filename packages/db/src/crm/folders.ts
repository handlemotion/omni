import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmCompanies, crmDeals } from "../schema/crm.ts";
import { memberStorage, type CreateFolderResult, type MemberStorage } from "../storage.ts";
import { NOT_FOUND, type CrmMember, type Ex } from "./core.ts";
import { loadCompany, loadDeal } from "./records.ts";

export type FolderResult =
  | { status: "ok"; nodeId: string; created: boolean }
  | Exclude<CreateFolderResult, { status: "ok" }>;

/** A deal's folder, and the company whose folder holds it (made too when it was missing). */
export type DealFolderResult =
  | { status: "ok"; nodeId: string; created: boolean; companyId: string | null }
  | Exclude<FolderResult, { status: "ok" }>;

export function folderName(name: string) {
  const clean = name
    .replaceAll(/[/\\]/g, "-")
    // oxlint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return clean === "" || clean === "." || clean === ".." ? "-" : clean;
}

async function isLiveFolder(storage: MemberStorage, nodeId: string | null) {
  if (!nodeId) return false;
  const listed = await storage.list({ parentId: nodeId }, { limit: 1 });
  return listed.status === "ok" && listed.folder?.node.space === "teamspace";
}

async function folderInOwnTeamspace(storage: MemberStorage, name: string) {
  const space = await storage.createTeamspace({ name: folderName(name) });
  if (space.status !== "ok") return space;
  const made = await storage.createFolder({ teamspaceId: space.teamspace.id }, folderName(name));
  if (made.status !== "ok") return made;
  return { status: "ok", node: made.node, teamspaceId: space.teamspace.id } as const;
}

const companyFolderIn: (
  tx: Ex,
  member: CrmMember,
  storage: MemberStorage,
  id: string,
) => Promise<FolderResult> = async (tx, member, storage, id) => {
  const company = await loadCompany(tx, member.orgId, id, true);
  if (!company) return NOT_FOUND;
  if (company.folderNodeId && (await isLiveFolder(storage, company.folderNodeId))) {
    return { status: "ok", nodeId: company.folderNodeId, created: false };
  }
  const made = await folderInOwnTeamspace(storage, company.name);
  if (made.status !== "ok") return made;
  await tx.update(crmCompanies).set({ folderNodeId: made.node.id }).where(eq(crmCompanies.id, id));
  return { status: "ok", nodeId: made.node.id, created: true };
};

/** The company's folder, at the top of its own teamspace, found or made. */
export function companyFolder(tx: Ex, member: CrmMember, id: string) {
  return companyFolderIn(tx, member, memberStorage(tx as Db, member.id), id);
}

/**
 * The deal's folder, found or made at the top of the deal's own teamspace. A deal made before
 * teamspaces gets its teamspace now.
 */
export const dealFolder: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<DealFolderResult> = async (tx, member, id) => {
  const storage = memberStorage(tx as Db, member.id);
  const peek = await loadDeal(tx, member.orgId, id);
  if (!peek) return NOT_FOUND;
  if (peek.companyId) await loadCompany(tx, member.orgId, peek.companyId, true);
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  const { companyId } = deal;
  if (deal.folderNodeId && (await isLiveFolder(storage, deal.folderNodeId))) {
    return { status: "ok", nodeId: deal.folderNodeId, created: false, companyId };
  }
  if (!deal.teamspaceId) {
    const made = await folderInOwnTeamspace(storage, deal.name);
    if (made.status !== "ok") return made;
    await tx
      .update(crmDeals)
      .set({ teamspaceId: made.teamspaceId, folderNodeId: made.node.id })
      .where(eq(crmDeals.id, id));
    return { status: "ok", nodeId: made.node.id, created: true, companyId };
  }
  const made = await storage.createFolder({ teamspaceId: deal.teamspaceId }, folderName(deal.name));
  if (made.status !== "ok") return made;
  await tx.update(crmDeals).set({ folderNodeId: made.node.id }).where(eq(crmDeals.id, id));
  return { status: "ok", nodeId: made.node.id, created: true, companyId };
};
