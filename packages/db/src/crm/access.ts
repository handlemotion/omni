import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { crmProjectMembers } from "../schema/crm/projects.ts";
import { userEmails } from "../schema/identity.ts";
import { memberStorage } from "../storage.ts";
import { FREELANCER_ROLE, NOT_FOUND, refuse, type CrmMember, type Ex } from "./core.ts";
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

async function grantFolder(tx: Ex, member: CrmMember, dealId: string, email: string) {
  const folder = await dealFolder(tx, member, dealId);
  if (folder.status !== "ok") refuse({ status: "sharing_refused", reason: folder.status });
  const put = await memberStorage(tx as Db, member.id).putGrant(folder.nodeId, email, "editor");
  if (put.status !== "ok") refuse({ status: "sharing_refused", reason: put.status });
}

async function revokeFolder(tx: Ex, member: CrmMember, dealId: string, email: string) {
  const deal = await loadDeal(tx, member.orgId, dealId);
  if (!deal?.folderNodeId) return;
  await memberStorage(tx as Db, member.id).removeGrant(deal.folderNodeId, email);
}

/**
 * Adds someone outside the team to a project, or changes their scope. A freelancer gets editor
 * on the project's folder; a client gets nothing in Drive from here (the portal shows them what
 * is theirs). Adding twice with the same scope changes nothing.
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
  if (input.scope === "freelancer" && before?.scope !== "freelancer") {
    await grantFolder(tx, member, dealId, email);
  }
  if (input.scope !== "freelancer" && before?.scope === "freelancer") {
    await revokeFolder(tx, member, dealId, email);
  }
  return {
    status: "ok" as const,
    added: !before,
    access: await accessOf(tx, member.orgId, dealId),
  };
}

/** Takes someone off a project, and a freelancer out of its folder. */
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
  if (removed.scope === "freelancer") await revokeFolder(tx, member, dealId, address);
  return { status: "ok" as const, access: await accessOf(tx, member.orgId, dealId) };
}
