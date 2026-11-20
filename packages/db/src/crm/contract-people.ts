import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { crmContractPeople } from "../schema/crm.ts";
import { memberStorage } from "../storage.ts";
import { FREELANCER_ROLE, refuse, type CrmMember, type Ex } from "./core.ts";
import { dealFolder } from "./folders.ts";
import { loadDeal } from "./records.ts";

/** The folder in a project's folder that only the team sees: contracts, signed copies. */
export const ADMIN_FOLDER_NAME = "Admin";

/** At most this many people involved in one contract. */
export const CONTRACT_PEOPLE_MAX = 20;

export type InvalidPeople = { status: "invalid_contract"; param: "memberIds" };

const invalidPeople = { status: "invalid_contract", param: "memberIds" } as const;

const isFreelancerRole = sql<boolean>`${FREELANCER_ROLE} = any(string_to_array(replace(${members.role}, ' ', ''), ','))`;

/** Each contract's people, by contract id, in the order they were added. */
export async function peopleOf(ex: Ex, contractIds: string[]) {
  const byContract = new Map<string, string[]>();
  if (contractIds.length === 0) return byContract;
  const rows = await ex
    .select({ contractId: crmContractPeople.contractId, memberId: crmContractPeople.memberId })
    .from(crmContractPeople)
    .where(inArray(crmContractPeople.contractId, contractIds))
    .orderBy(crmContractPeople.createdAt, crmContractPeople.memberId);
  for (const row of rows) {
    byContract.set(row.contractId, [...(byContract.get(row.contractId) ?? []), row.memberId]);
  }
  return byContract;
}

/** Each contract with `memberIds`: who on the workspace it involves. */
export async function withPeople<T extends { id: string }>(ex: Ex, contracts: T[]) {
  const people = await peopleOf(
    ex,
    contracts.map((contract) => contract.id),
  );
  return contracts.map((contract) => ({ ...contract, memberIds: people.get(contract.id) ?? [] }));
}

/** SQL: the contract involves the member. */
export const involves = (contractId: Parameters<typeof eq>[0], memberId: string) =>
  sql`exists (select 1 from ${crmContractPeople} where ${crmContractPeople.contractId} = ${contractId} and ${crmContractPeople.memberId} = ${memberId})`;

async function freelancersOf(ex: Ex, orgId: string, memberIds: string[]) {
  if (memberIds.length === 0) return [];
  return ex
    .select({ id: members.id, email: sql<string>`lower(${users.email})` })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(eq(members.organizationId, orgId), inArray(members.id, memberIds), isFreelancerRole),
    );
}

/**
 * Sets who a contract involves: members of the workspace, teammates or freelancers. Unknown
 * members refuse the whole change.
 */
export async function setPeople(tx: Ex, member: CrmMember, contractId: string, ids: string[]) {
  const memberIds = [...new Set(ids)];
  if (memberIds.length > CONTRACT_PEOPLE_MAX) return invalidPeople;
  if (memberIds.length) {
    const found = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.organizationId, member.orgId), inArray(members.id, memberIds)));
    if (found.length !== memberIds.length) return invalidPeople;
  }
  const before = (await peopleOf(tx, [contractId])).get(contractId) ?? [];
  const gone = before.filter((id) => !memberIds.includes(id));
  if (gone.length) {
    await tx
      .delete(crmContractPeople)
      .where(
        and(
          eq(crmContractPeople.contractId, contractId),
          inArray(crmContractPeople.memberId, gone),
        ),
      );
  }
  const added = memberIds.filter((id) => !before.includes(id));
  if (added.length) {
    await tx
      .insert(crmContractPeople)
      .values(added.map((id) => ({ contractId, memberId: id, orgId: member.orgId })))
      .onConflictDoNothing();
  }
  return { status: "ok" as const, gone };
}

async function findAdminFolder(tx: Ex, member: CrmMember, folderId: string) {
  const storage = memberStorage(tx as Db, member.id);
  let cursor = null;
  do {
    const listed = await storage.list({ parentId: folderId }, { cursor, limit: 200 });
    if (listed.status !== "ok") return null;
    const admin = listed.nodes.find((node) => node.kind === "folder" && node.teamOnly);
    if (admin) return admin.id;
    cursor = listed.nextCursor;
  } while (cursor);
  return null;
}

/** The project's Admin folder, found or made inside its folder: only the team sees it. */
export async function adminFolder(tx: Ex, member: CrmMember, dealId: string) {
  const folder = await dealFolder(tx, member, dealId);
  if (folder.status !== "ok") return folder;
  const found = await findAdminFolder(tx, member, folder.nodeId);
  if (found) return { status: "ok" as const, nodeId: found };
  const made = await memberStorage(tx as Db, member.id).createFolder(
    { parentId: folder.nodeId },
    ADMIN_FOLDER_NAME,
    { teamOnly: true },
  );
  if (made.status !== "ok") return made;
  return { status: "ok" as const, nodeId: made.node.id };
}

interface ContractFiles {
  id: string;
  dealId: string | null;
  documentNodeId: string | null;
  signedNodeId: string | null;
}

const filesOf = (contract: ContractFiles) =>
  [...new Set([contract.documentNodeId, contract.signedNodeId])].filter(
    (id): id is string => id !== null,
  );

/**
 * Moves a deal contract's files that sit loose in the project's folder into its Admin folder,
 * locked ones too. A file kept anywhere else stays where the team put it.
 */
export async function fileContract(tx: Ex, member: CrmMember, contract: ContractFiles) {
  if (!contract.dealId) return;
  const deal = await loadDeal(tx, member.orgId, contract.dealId);
  if (!deal?.folderNodeId) return;
  const storage = memberStorage(tx as Db, member.id);
  for (const nodeId of filesOf(contract)) {
    const found = await storage.node(nodeId);
    if (found?.node.parentId !== deal.folderNodeId) continue;
    const admin = await adminFolder(tx, member, contract.dealId);
    if (admin.status !== "ok") return;
    const moved = await storage.fileAway(nodeId, { parentId: admin.nodeId });
    if (moved.status !== "ok") refuse({ status: "invalid_contract", param: "documentNodeId" });
  }
}

/**
 * Gives the freelancers a contract involves viewer on its files, which sit where their project
 * grant does not reach, and takes it from those in `gone` and off files in `oldFiles`.
 */
export async function shareContract(
  tx: Ex,
  member: CrmMember,
  contract: ContractFiles,
  change: { gone?: string[]; oldFiles?: string[] } = {},
) {
  const storage = memberStorage(tx as Db, member.id);
  const files = filesOf(contract);
  const people = (await peopleOf(tx, [contract.id])).get(contract.id) ?? [];
  const now = await freelancersOf(tx, member.orgId, people);
  const gone = await freelancersOf(tx, member.orgId, change.gone ?? []);
  for (const nodeId of files) {
    for (const person of now) await storage.putGrant(nodeId, person.email, "viewer");
    for (const person of gone) await storage.removeGrant(nodeId, person.email);
  }
  for (const nodeId of (change.oldFiles ?? []).filter((id) => !files.includes(id))) {
    for (const person of now) await storage.removeGrant(nodeId, person.email);
  }
}
