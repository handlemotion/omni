import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmFileLinks } from "../schema/crm/files.ts";
import { memberStorage, type StorageNode } from "../storage.ts";
import { NOT_FOUND, type CrmMember, type Ex } from "./core.ts";
import { companyFolder, dealFolder } from "./folders.ts";
import { loadCompany, loadDeal } from "./records.ts";

/** The record a Drive node is linked to: a company or a deal (`docs/spec/crm.md`, "Keep the files"). */
export type FileLinkRecord = { companyId: string } | { dealId: string };

/** A linked node as the reading member sees it in Drive. */
export interface CrmFileLink {
  node: StorageNode;
  linkedAt: Date;
  linkedByMemberId: string | null;
}

/** At most this many nodes in one link call, and links shown on one record. */
export const FILE_LINKS_MAX = 200;

const recordColumn = (record: FileLinkRecord) =>
  "companyId" in record
    ? eq(crmFileLinks.companyId, record.companyId)
    : eq(crmFileLinks.dealId, record.dealId);

async function recordExists(ex: Ex, member: CrmMember, record: FileLinkRecord) {
  return "companyId" in record
    ? !!(await loadCompany(ex, member.orgId, record.companyId))
    : !!(await loadDeal(ex, member.orgId, record.dealId));
}

async function openable(ex: Ex, member: CrmMember, nodeIds: string[]) {
  const storage = memberStorage(ex as Db, member.id);
  const views = await Promise.all(nodeIds.map((id) => storage.node(id)));
  return new Map(
    views.flatMap((view) =>
      view && !view.inTrash && view.node.orgId === member.orgId ? [[view.node.id, view.node]] : [],
    ),
  );
}

/** The record's links the member can open, newest first. */
export async function fileLinksOf(ex: Ex, member: CrmMember, record: FileLinkRecord) {
  if (!(await recordExists(ex, member, record))) return NOT_FOUND;
  const rows = await ex
    .select({
      nodeId: crmFileLinks.nodeId,
      linkedAt: crmFileLinks.createdAt,
      linkedByMemberId: crmFileLinks.addedByMemberId,
    })
    .from(crmFileLinks)
    .where(and(eq(crmFileLinks.orgId, member.orgId), recordColumn(record)))
    .orderBy(desc(crmFileLinks.createdAt), desc(crmFileLinks.id))
    .limit(FILE_LINKS_MAX);
  const nodes = await openable(
    ex,
    member,
    rows.map((row) => row.nodeId),
  );
  const links: CrmFileLink[] = rows.flatMap((row) => {
    const node = nodes.get(row.nodeId);
    return node ? [{ node, linkedAt: row.linkedAt, linkedByMemberId: row.linkedByMemberId }] : [];
  });
  return { status: "ok" as const, links };
}

/**
 * Links Drive nodes to the record where they are: nothing moves or copies. Every node must be one
 * the member can open now and not in Trash, or nothing is linked. A node already linked stays
 * linked once, so a retried call changes nothing. The record's folder is found or made too, as
 * for its first upload, so a record with files always has one.
 */
export async function linkFiles(
  tx: Ex,
  member: CrmMember,
  record: FileLinkRecord,
  nodeIds: string[],
) {
  if (!(await recordExists(tx, member, record))) return NOT_FOUND;
  const ids = [...new Set(nodeIds)];
  const nodes = await openable(tx, member, ids);
  if (ids.some((id) => !nodes.has(id))) return NOT_FOUND;
  const folder =
    "companyId" in record
      ? await companyFolder(tx, member, record.companyId)
      : await dealFolder(tx, member, record.dealId);
  if (folder.status !== "ok") return folder;
  await tx
    .insert(crmFileLinks)
    .values(
      ids.map((nodeId) => ({
        orgId: member.orgId,
        ...record,
        nodeId,
        addedByMemberId: member.id,
      })),
    )
    .onConflictDoNothing();
  return { status: "ok" as const, created: ids.length };
}

/** Drops the link; the node stays where it is in Drive. Unlinking twice is not an error. */
export async function unlinkFile(
  tx: Ex,
  member: CrmMember,
  record: FileLinkRecord,
  nodeId: string,
) {
  if (!(await recordExists(tx, member, record))) return NOT_FOUND;
  const removed = await tx
    .delete(crmFileLinks)
    .where(
      and(
        eq(crmFileLinks.orgId, member.orgId),
        recordColumn(record),
        inArray(crmFileLinks.nodeId, [nodeId]),
      ),
    )
    .returning({ id: crmFileLinks.id });
  return { status: "ok" as const, removed: removed.length > 0 };
}
