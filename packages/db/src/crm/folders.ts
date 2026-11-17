// A record's folder in Shared (ADR 0036 decision 5): `Shared / Clients / <company> / <deal>`, a
// deal with no company directly under `Clients`. The record stores the folder's node id, so a
// rename or move in Storage changes nothing here; a folder that was deleted or trashed, or moved
// out of Shared, is replaced by a new one on the next call.
//
// Find-or-create runs under a row lock on the record (and on `crm_settings` for `Clients`), so
// two first calls at once make one folder. Folders are made only through Storage's member door,
// opened on this transaction (ADR 0035 decision 4): a taken name gets Storage's own number.
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

/** A record's name as a folder name: Storage refuses slashes and control characters. */
function folderName(name: string) {
  const clean = name
    .replaceAll(/[/\\]/g, "-")
    // oxlint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return clean === "" || clean === "." || clean === ".." ? "-" : clean;
}

/** Whether `nodeId` is a live folder in Shared that the member reaches. */
async function isLiveFolder(storage: MemberStorage, nodeId: string | null) {
  if (!nodeId) return false;
  const listed = await storage.list({ parentId: nodeId }, { limit: 1 });
  return listed.status === "ok" && listed.folder?.node.space === "shared";
}

/** `Clients`, found or made at the root of Shared. */
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

/** The company's folder, `Shared / Clients / <company>`, found or made. */
export function companyFolder(tx: Ex, member: CrmMember, id: string) {
  return companyFolderIn(tx, member, memberStorage(tx as Db, member.id), id);
}

/**
 * The deal's folder, found or made: inside its company's folder (found or made too), or under
 * `Clients` when it has no company.
 */
export const dealFolder: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<DealFolderResult> = async (tx, member, id) => {
  const storage = memberStorage(tx as Db, member.id);
  // Lock order is company, then deal, as contract writes take them (`contracts.ts`), so a folder
  // request and a signing on the same deal never wait on each other in a cycle.
  const peek = await loadDeal(tx, member.orgId, id);
  if (!peek) return NOT_FOUND;
  if (peek.companyId) await loadCompany(tx, member.orgId, peek.companyId, true);
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  const { companyId } = deal;
  if (deal.folderNodeId && (await isLiveFolder(storage, deal.folderNodeId))) {
    return { status: "ok", nodeId: deal.folderNodeId, created: false, companyId };
  }
  const parent = companyId
    ? await companyFolderIn(tx, member, storage, companyId)
    : await rootFolder(tx, member, storage);
  if (parent.status !== "ok") return parent;
  const made = await storage.createFolder({ parentId: parent.nodeId }, folderName(deal.name));
  if (made.status !== "ok") return made;
  await tx.update(crmDeals).set({ folderNodeId: made.node.id }).where(eq(crmDeals.id, id));
  return { status: "ok", nodeId: made.node.id, created: true, companyId };
};
