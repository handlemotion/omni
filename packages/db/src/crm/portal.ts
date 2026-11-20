import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Db } from "../client.ts";
import { organizations } from "../schema/auth.ts";
import { crmCompanies, crmContracts, crmDeals, crmStages } from "../schema/crm.ts";
import { crmDeliverables, crmPortals, crmProjectMembers } from "../schema/crm/projects.ts";
import { storageAddresses, userStorage, type StorageNode } from "../storage.ts";
import { NOT_FOUND, type Ex } from "./core.ts";
import { planOf, type CrmDeliverable, type CrmMilestone } from "./plan.ts";

/**
 * The client door (`docs/spec/crm.md`, "Client portal"): a person outside the workspace reaches
 * the projects one of their verified addresses was added to as a client, and on each only what is
 * meant for them. Nothing here reads as a member: there is none.
 */
export interface PortalPerson {
  db: Db;
  userId: string;
  scopeOrgId?: string | null;
}

export interface PortalProject {
  id: string;
  name: string;
  orgId: string;
  workspaceName: string;
  companyName: string | null;
  stage: { name: string; kind: "open" | "won" | "done" | "lost" };
}

export interface PortalFile {
  id: string;
  name: string;
  kind: "file" | "folder";
  size: number;
  mimeType: string | null;
  updatedAt: Date;
}

export interface PortalContract {
  id: string;
  title: string;
  status: "sent" | "signed" | "ended";
  signedAt: Date | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  /** Their signature request: they sign, and later download the signed copy, at `/sign/:id`. */
  signingRequestId: string | null;
}

export type PortalDeliverable = Omit<CrmDeliverable, "createdByMemberId" | "clientVisible"> & {
  /** The file, when they can open it (it sits in the portal's folder). */
  file: PortalFile | null;
};

export interface PortalProjectDetail {
  project: PortalProject;
  milestones: Omit<CrmMilestone, "createdByMemberId">[];
  deliverables: PortalDeliverable[];
  contracts: PortalContract[];
  /** The portal's folder and what is in it; null until the team made one. */
  folder: { id: string; shareId: string | null; files: PortalFile[] } | null;
}

const projectColumns = {
  id: crmDeals.id,
  name: crmDeals.name,
  orgId: crmDeals.orgId,
  workspaceName: organizations.name,
  companyName: crmCompanies.name,
  stageName: crmStages.name,
  stageKind: crmStages.kind,
};

async function addressesOf(person: PortalPerson) {
  return storageAddresses(person.db, person.userId, person.scopeOrgId);
}

function selectProjects(ex: Ex, addresses: string[], scopeOrgId?: string | null, dealId?: string) {
  return ex
    .selectDistinct(projectColumns)
    .from(crmProjectMembers)
    .innerJoin(
      crmDeals,
      and(eq(crmDeals.id, crmProjectMembers.dealId), eq(crmDeals.orgId, crmProjectMembers.orgId)),
    )
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .innerJoin(organizations, eq(organizations.id, crmDeals.orgId))
    .leftJoin(crmCompanies, eq(crmCompanies.id, crmDeals.companyId))
    .where(
      and(
        eq(crmProjectMembers.scope, "client"),
        inArray(crmProjectMembers.email, addresses),
        scopeOrgId ? eq(crmDeals.orgId, scopeOrgId) : undefined,
        dealId ? eq(crmDeals.id, dealId) : undefined,
      ),
    );
}

const toProject = (row: Awaited<ReturnType<typeof selectProjects>>[number]) =>
  ({
    id: row.id,
    name: row.name,
    orgId: row.orgId,
    workspaceName: row.workspaceName,
    companyName: row.companyName,
    stage: { name: row.stageName, kind: row.stageKind },
  }) satisfies PortalProject;

/** Every project they are a client on, by workspace and name. */
export async function portalProjects(person: PortalPerson) {
  const addresses = await addressesOf(person);
  if (addresses.length === 0) return { status: "ok" as const, projects: [] };
  const rows = await selectProjects(person.db, addresses, person.scopeOrgId).orderBy(
    asc(organizations.name),
    asc(crmDeals.name),
    asc(crmDeals.id),
  );
  return { status: "ok" as const, projects: rows.map(toProject) };
}

async function projectFor(person: PortalPerson, dealId: string) {
  const addresses = await addressesOf(person);
  if (addresses.length === 0) return null;
  const [row] = await selectProjects(person.db, addresses, person.scopeOrgId, dealId);
  return row ? { project: toProject(row), addresses } : null;
}

const toFile = (node: StorageNode) =>
  ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    size: node.size,
    mimeType: node.mimeType,
    updatedAt: node.updatedAt,
  }) satisfies PortalFile;

async function contractsOf(person: PortalPerson, project: PortalProject) {
  const rows = await person.db
    .select({
      id: crmContracts.id,
      title: crmContracts.title,
      status: crmContracts.status,
      signedAt: crmContracts.signedAt,
      effectiveOn: crmContracts.effectiveOn,
      expiresOn: crmContracts.expiresOn,
      requestId: crmContracts.signatureRequestId,
    })
    .from(crmContracts)
    .where(
      and(
        eq(crmContracts.orgId, project.orgId),
        eq(crmContracts.dealId, project.id),
        ne(crmContracts.status, "draft"),
      ),
    )
    .orderBy(asc(crmContracts.createdAt), asc(crmContracts.id));
  const storage = userStorage(person.db, person.userId, person.scopeOrgId);
  return Promise.all(
    rows.map(async ({ requestId, status, ...row }) => {
      const mine = requestId ? await storage.signingRequest(requestId) : null;
      return {
        ...row,
        status: status as PortalContract["status"],
        signingRequestId: mine ? requestId : null,
      } satisfies PortalContract;
    }),
  );
}

async function folderOf(person: PortalPerson, project: PortalProject) {
  const [portal] = await person.db
    .select({ folderNodeId: crmPortals.folderNodeId })
    .from(crmPortals)
    .where(and(eq(crmPortals.dealId, project.id), isNotNull(crmPortals.folderNodeId)));
  if (!portal?.folderNodeId) return null;
  const storage = userStorage(person.db, person.userId, person.scopeOrgId);
  const listed = await storage.list({ parentId: portal.folderNodeId }, { limit: 200 });
  if (listed.status !== "ok") return null;
  const shareId = await storage.linkOf(portal.folderNodeId);
  return { id: portal.folderNodeId, shareId, files: listed.nodes.map(toFile) };
}

async function deliverablesOf(person: PortalPerson, deliverables: CrmDeliverable[]) {
  const storage = userStorage(person.db, person.userId, person.scopeOrgId);
  return Promise.all(
    deliverables
      .filter((d) => d.clientVisible)
      .map(async ({ createdByMemberId: _by, clientVisible: _shown, ...d }) => {
        const view = d.nodeId ? await storage.node(d.nodeId) : null;
        return { ...d, file: view ? toFile(view.node) : null } satisfies PortalDeliverable;
      }),
  );
}

/** One project as its client sees it. */
export async function portalProject(person: PortalPerson, dealId: string) {
  const found = await projectFor(person, dealId);
  if (!found) return NOT_FOUND;
  const { project } = found;
  const plan = await planOf(person.db, project.orgId, project.id);
  const detail: PortalProjectDetail = {
    project,
    milestones: plan.milestones.map(({ createdByMemberId: _by, ...m }) => m),
    deliverables: await deliverablesOf(person, plan.deliverables),
    contracts: await contractsOf(person, project),
    folder: await folderOf(person, project),
  };
  return { status: "ok" as const, detail };
}

export type ReviewDecision = "approve" | "request_changes";
export type NotInReview = { status: "not_in_review" };
export type NoteRequired = { status: "note_required" };

/**
 * The client approves a deliverable or asks for changes, while it is in review and shown to them.
 * Their answer is final until the team puts it in review again.
 */
export async function reviewDeliverable(
  person: PortalPerson,
  dealId: string,
  id: string,
  input: { decision: ReviewDecision; note?: string | null },
) {
  const found = await projectFor(person, dealId);
  if (!found) return NOT_FOUND;
  const note = input.note?.trim().slice(0, 5000) || null;
  if (input.decision === "request_changes" && !note) return { status: "note_required" } as const;
  const [row] = await person.db
    .select({ email: crmProjectMembers.email })
    .from(crmProjectMembers)
    .where(
      and(
        eq(crmProjectMembers.dealId, dealId),
        eq(crmProjectMembers.scope, "client"),
        inArray(crmProjectMembers.email, found.addresses),
      ),
    )
    .limit(1);
  const [changed] = await person.db
    .update(crmDeliverables)
    .set({
      status: input.decision === "approve" ? "approved" : "changes_requested",
      reviewNote: note,
      reviewedAt: new Date(),
      reviewedByEmail: row?.email ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(crmDeliverables.id, id),
        eq(crmDeliverables.orgId, found.project.orgId),
        eq(crmDeliverables.dealId, dealId),
        eq(crmDeliverables.clientVisible, true),
        eq(crmDeliverables.status, "in_review"),
      ),
    )
    .returning({ id: crmDeliverables.id });
  if (!changed) {
    const shown = (await planOf(person.db, found.project.orgId, dealId)).deliverables.some(
      (d) => d.id === id && d.clientVisible,
    );
    return shown ? ({ status: "not_in_review" } as const) : NOT_FOUND;
  }
  return portalProject(person, dealId);
}
