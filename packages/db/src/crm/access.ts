import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { crmContracts } from "../schema/crm.ts";
import { crmPortals, crmProjectMembers } from "../schema/crm/projects.ts";
import { userEmails } from "../schema/identity.ts";
import { memberStorage } from "../storage.ts";
import { FREELANCER_ROLE, NOT_FOUND, refuse, type CrmMember, type Ex } from "./core.ts";
import { fileContract, shareContract, unshareContracts } from "./contract-people.ts";
import { contractColumns } from "./contracts.ts";
import { dealFolder } from "./folders.ts";
import { loadDeal } from "./records.ts";

/** How far someone outside the team reaches into one project. */
export type ProjectScope = "freelancer" | "client";

/** Someone added to a project, by address. */
export interface CrmProjectAccess {
  email: string;
  scope: ProjectScope;
  /** Their name, once the address belongs to an account. */
  name: string | null;
  addedByMemberId: string | null;
  createdAt: Date;
}

export type InvalidEmail = { status: "invalid_email" };
/** The address is a teammate's, who already sees every project. */
export type AlreadyTeammate = { status: "already_teammate" };

/** Drive refused the folder grant: a policy against sharing outside the company, say. */
export type SharingRefused = { status: "sharing_refused"; reason: string };
export type TooMany = { status: "too_many" };

export type GrantAccessResult =
  | { status: "ok"; added: boolean; access: CrmProjectAccess[] }
  | { status: "not_found" }
  | InvalidEmail
  | AlreadyTeammate
  | TooMany
  | SharingRefused;

/** At most this many people outside the team on one project. */
export const PROJECT_ACCESS_MAX = 50;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const accessColumns = {
  email: crmProjectMembers.email,
  scope: crmProjectMembers.scope,
  name: users.name,
  addedByMemberId: crmProjectMembers.addedByMemberId,
  createdAt: crmProjectMembers.createdAt,
};

async function accessOf(ex: Ex, orgId: string, dealId: string) {
  return ex
    .select(accessColumns)
    .from(crmProjectMembers)
    .leftJoin(userEmails, eq(sql`lower(${userEmails.email})`, crmProjectMembers.email))
    .leftJoin(
      users,
      or(eq(users.id, userEmails.userId), eq(sql`lower(${users.email})`, crmProjectMembers.email)),
    )
    .where(and(eq(crmProjectMembers.orgId, orgId), eq(crmProjectMembers.dealId, dealId)))
    .orderBy(asc(crmProjectMembers.createdAt), asc(crmProjectMembers.email));
}

/** Everyone outside the team on the project, oldest first. */
export async function listAccess(ex: Ex, member: CrmMember, dealId: string) {
  if (!(await loadDeal(ex, member.orgId, dealId))) return NOT_FOUND;
  return { status: "ok" as const, access: await accessOf(ex, member.orgId, dealId) };
}

async function isTeammate(ex: Ex, orgId: string, email: string) {
  const [row] = await ex
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(userEmails, eq(userEmails.userId, users.id))
    .where(
      and(
        eq(members.organizationId, orgId),
        sql`not (${FREELANCER_ROLE} = any(string_to_array(replace(${members.role}, ' ', ''), ',')))`,
        or(
          and(eq(sql`lower(${users.email})`, email), eq(users.emailVerified, true)),
          eq(sql`lower(${userEmails.email})`, email),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

const PORTAL_FOLDER_NAME = "Client";

const sharingRefused = (reason: string) => refuse({ status: "sharing_refused", reason });

async function portalOf(tx: Ex, dealId: string) {
  const [portal] = await tx
    .select({ folderNodeId: crmPortals.folderNodeId })
    .from(crmPortals)
    .where(eq(crmPortals.dealId, dealId));
  return portal ?? null;
}

async function portalFolder(tx: Ex, member: CrmMember, dealId: string, parentId: string) {
  const portal = await portalOf(tx, dealId);
  const storage = memberStorage(tx as Db, member.id);
  const live = portal?.folderNodeId ? await storage.node(portal.folderNodeId) : null;
  if (live && !live.inTrash) return live.node.id;
  const made = await storage.createFolder({ parentId }, PORTAL_FOLDER_NAME);
  if (made.status !== "ok") return sharingRefused(made.status);
  await tx
    .insert(crmPortals)
    .values({ dealId, orgId: member.orgId, folderNodeId: made.node.id })
    .onConflictDoUpdate({ target: crmPortals.dealId, set: { folderNodeId: made.node.id } });
  const clients = (await accessOf(tx, member.orgId, dealId)).filter((r) => r.scope === "client");
  for (const client of clients) {
    if (portal?.folderNodeId) {
      const removed = await storage.removeGrant(portal.folderNodeId, client.email);
      if (removed.status === "forbidden") return sharingRefused("forbidden");
    }
    const put = await storage.putGrant(made.node.id, client.email, "viewer");
    if (put.status !== "ok") return sharingRefused(put.status);
  }
  return made.node.id;
}

async function grantFolder(
  tx: Ex,
  member: CrmMember,
  dealId: string,
  email: string,
  scope: ProjectScope,
) {
  const folder = await dealFolder(tx, member, dealId);
  if (folder.status !== "ok") return sharingRefused(folder.status);
  const storage = memberStorage(tx as Db, member.id);
  const target =
    scope === "freelancer" ? folder.nodeId : await portalFolder(tx, member, dealId, folder.nodeId);
  const put = await storage.putGrant(target, email, scope === "freelancer" ? "editor" : "viewer");
  if (put.status !== "ok") sharingRefused(put.status);
  if (scope === "freelancer") {
    await fileContractsOf(tx, member, dealId);
  }
}

const contractsOf = (tx: Ex, member: CrmMember, dealId: string) =>
  tx
    .select(contractColumns)
    .from(crmContracts)
    .where(and(eq(crmContracts.orgId, member.orgId), eq(crmContracts.dealId, dealId)));

async function fileContractsOf(tx: Ex, member: CrmMember, dealId: string) {
  for (const contract of await contractsOf(tx, member, dealId)) {
    await fileContract(tx, member, contract);
    await shareContract(tx, member, contract);
  }
}

async function revokeFolder(
  tx: Ex,
  member: CrmMember,
  dealId: string,
  email: string,
  scope: ProjectScope,
) {
  const folderNodeId =
    scope === "freelancer"
      ? (await loadDeal(tx, member.orgId, dealId))?.folderNodeId
      : (await portalOf(tx, dealId))?.folderNodeId;
  if (!folderNodeId) return;
  const removed = await memberStorage(tx as Db, member.id).removeGrant(folderNodeId, email);
  if (removed.status === "forbidden") sharingRefused("forbidden");
  if (scope === "freelancer") {
    await unshareContracts(tx, member, await contractsOf(tx, member, dealId), email);
  }
}

/**
 * Adds someone outside the team to a project, or changes their scope, with the Drive grant that
 * goes with it. Adding twice with the same scope changes nothing.
 */
export async function grantAccess(
  tx: Ex,
  member: CrmMember,
  dealId: string,
  input: { email: string; scope: ProjectScope },
) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) return { status: "invalid_email" } as const;
  if (!(await loadDeal(tx, member.orgId, dealId, true))) return NOT_FOUND;
  if (await isTeammate(tx, member.orgId, email)) return { status: "already_teammate" } as const;
  const current = await accessOf(tx, member.orgId, dealId);
  const before = current.find((row) => row.email === email);
  if (!before && current.length >= PROJECT_ACCESS_MAX) return { status: "too_many" } as const;
  await tx
    .insert(crmProjectMembers)
    .values({ orgId: member.orgId, dealId, email, scope: input.scope, addedByMemberId: member.id })
    .onConflictDoUpdate({
      target: [crmProjectMembers.dealId, crmProjectMembers.email],
      set: { scope: input.scope },
    });
  if (before?.scope !== input.scope) {
    if (before) await revokeFolder(tx, member, dealId, email, before.scope);
    await grantFolder(tx, member, dealId, email, input.scope);
  }
  return {
    status: "ok" as const,
    added: !before,
    access: await accessOf(tx, member.orgId, dealId),
  };
}

/** Takes someone off a project, and out of the folder their scope reached. */
export async function revokeAccess(tx: Ex, member: CrmMember, dealId: string, email: string) {
  const address = email.trim().toLowerCase();
  const [removed] = await tx
    .delete(crmProjectMembers)
    .where(
      and(
        eq(crmProjectMembers.orgId, member.orgId),
        eq(crmProjectMembers.dealId, dealId),
        eq(crmProjectMembers.email, address),
      ),
    )
    .returning({ scope: crmProjectMembers.scope });
  if (!removed) return NOT_FOUND;
  await revokeFolder(tx, member, dealId, address, removed.scope);
  return { status: "ok" as const, access: await accessOf(tx, member.orgId, dealId) };
}
