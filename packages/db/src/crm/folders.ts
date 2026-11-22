import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmCompanies, crmDeals, crmSettings } from "../schema/crm.ts";
import { memberStorage, type CreateFolderResult, type MemberStorage } from "../storage.ts";
import { NOT_FOUND, type CrmMember, type Ex } from "./core.ts";
import { loadCompany, loadDeal } from "./records.ts";
import { ensureCrm } from "./stages.ts";

/** What a new workspace's record folders sit in; a workspace may rename it in Storage. */
export const CRM_ROOT_FOLDER_NAME = "Clients";

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
  const space = listed.status === "ok" ? listed.folder?.node.space : undefined;
  return space === "shared" || space === "teamspace";
}

const rootFolder: (
  tx: Ex,
  member: CrmMember,
  storage: MemberStorage,
) => Promise<FolderResult> = async (tx, member, storage) => {
  await ensureCrm(tx, member.orgId);
  const [settings] = await tx
    .select({ nodeId: crmSettings.rootFolderNodeId })
    .from(crmSettings)
    .where(eq(crmSettings.orgId, member.orgId))
    .for("update");
  const stored = settings?.nodeId ?? null;
  if (stored && (await isLiveFolder(storage, stored))) {
    return { status: "ok", nodeId: stored, created: false };
  }
  const made = await storage.createFolder({ space: "shared" }, CRM_ROOT_FOLDER_NAME);
  if (made.status !== "ok") return made;
  await tx
    .update(crmSettings)
    .set({ rootFolderNodeId: made.node.id })
    .where(eq(crmSettings.orgId, member.orgId));
  return { status: "ok", nodeId: made.node.id, created: true };
};

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
  const root = await rootFolder(tx, member, storage);
  if (root.status !== "ok") return root;
  const made = await storage.createFolder({ parentId: root.nodeId }, folderName(company.name));
  if (made.status !== "ok") return made;
  await tx.update(crmCompanies).set({ folderNodeId: made.node.id }).where(eq(crmCompanies.id, id));
  return { status: "ok", nodeId: made.node.id, created: true };
};

async function legacyParent(
  tx: Ex,
  member: CrmMember,
  storage: MemberStorage,
  companyId: string | null,
) {
  const parent = companyId
    ? await companyFolderIn(tx, member, storage, companyId)
    : await rootFolder(tx, member, storage);
  return parent.status === "ok" ? { parentId: parent.nodeId } : parent;
}

/** The company's folder, `Shared / Clients / <company>`, found or made. */
export function companyFolder(tx: Ex, member: CrmMember, id: string) {
  return companyFolderIn(tx, member, memberStorage(tx as Db, member.id), id);
}

/**
 * The deal's folder, found or made: at the top of its own teamspace, or, for a deal made before
 * teamspaces, inside its company's folder (found or made too), or under `Clients` when it has no
 * company.
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
  const place = deal.teamspaceId
    ? { teamspaceId: deal.teamspaceId }
    : await legacyParent(tx, member, storage, companyId);
  if ("status" in place) return place;
  const made = await storage.createFolder(place, folderName(deal.name));
  if (made.status !== "ok") return made;
  await tx.update(crmDeals).set({ folderNodeId: made.node.id }).where(eq(crmDeals.id, id));
  return { status: "ok", nodeId: made.node.id, created: true, companyId };
};
