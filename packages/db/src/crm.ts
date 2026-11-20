import type { Db } from "./client.ts";
import {
  addCompanyDomain,
  archiveCompany,
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  removeCompanyDomain,
  restoreCompany,
  updateCompany,
  type CompanyPatch,
  type ListCompaniesInput,
} from "./crm/companies.ts";
import {
  grantAccess,
  listAccess,
  revokeAccess,
  type GrantAccessResult,
  type ProjectScope,
} from "./crm/access.ts";
import { bulkCrm, type CrmBulkAction, type CrmBulkRecords } from "./crm/bulk.ts";
import { changeCompany, type CompanyChange } from "./crm/company-change.ts";
import {
  contractToSend,
  markContractSent,
  openRequestOf,
  withdrawContract,
} from "./crm/contract-signing.ts";
import { recordSignedCopy, type SignedCopyInput } from "./crm/contract-signed-copy.ts";
import {
  createContract,
  deleteContract,
  listContracts,
  updateContract,
  type ContractInput,
  type ContractPatch,
  type ListContractsInput,
} from "./crm/contracts.ts";
import {
  ANYONE,
  asMember,
  crmAudience,
  TEAM_ONLY,
  writeAsMember,
  type CrmDoor,
  type CrmMember,
  type CrmRecordRef,
  type Freelancer,
} from "./crm/core.ts";
import {
  archiveDeal,
  createDeal,
  deleteDeal,
  getDeal,
  listDeals,
  moveDeals,
  restoreDeal,
  updateDeal,
  type DealInput,
  type DealPatch,
  type ListDealsInput,
} from "./crm/deals.ts";
import { fileLinksOf, linkFiles, unlinkFile, type FileLinkRecord } from "./crm/files.ts";
import { companyFolder, dealFolder } from "./crm/folders.ts";
import {
  createNote,
  deleteNote,
  eventsOf,
  notesOf,
  updateNote,
  type TimelinePage,
} from "./crm/notes.ts";
import {
  addPerson,
  archivePerson,
  deletePerson,
  getPerson,
  getPersonDetail,
  listPeople,
  restorePerson,
  updatePerson,
  type AddPersonInput,
  type ListPeopleInput,
  type UpdatePersonInput,
} from "./crm/people.ts";
import {
  createDeliverable,
  createMilestone,
  deleteDeliverable,
  deleteMilestone,
  getPlan,
  updateDeliverable,
  updateMilestone,
  type DeliverableInput,
  type DeliverablePatch,
  type MilestoneInput,
  type MilestonePatch,
} from "./crm/plan.ts";
import {
  deliverableOnProject,
  freelancerDeal,
  freelancerDeals,
  freelancerEvents,
  freelancerLookup,
  freelancerNotes,
  freelancerSearch,
  freelancerTasks,
  milestoneOnProject,
  noteOnProject,
  onProject,
  onProjectRecord,
  taskChangeOnProject,
  taskOnProject,
} from "./crm/scope.ts";
import {
  portalProject,
  portalProjects,
  reviewDeliverable,
  type PortalPerson,
  type ReviewDecision,
} from "./crm/portal.ts";
import { lookupCrm, searchCrm } from "./crm/search.ts";
import { setDealIcon } from "./crm/deal-icon.ts";
import { getSettings, putSettings } from "./crm/settings.ts";
import { replaceStages, stagesOf, type StageInput } from "./crm/stages.ts";
import {
  countTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  type ListTasksInput,
  type TaskInput,
  type TaskPatch,
} from "./crm/tasks.ts";

export {
  BULK_MAX,
  type CrmBulkAction,
  type CrmBulkRecords,
  type CrmBulkResult,
} from "./crm/bulk.ts";
export type { CrmListCursor, CrmSort, CrmSortDir, CrmSortKey } from "./crm/list-order.ts";
export type { CompanyChange } from "./crm/company-change.ts";
export type {
  CompanyPatch,
  CreatedRange,
  ListRecordsInput,
  CompanyDetailResult,
  CompanyResult,
  CreateCompanyResult,
  DeleteResult,
  DomainRefusal,
  DomainResult,
  InvalidName,
  ListCompaniesInput,
  UpdateCompanyResult,
} from "./crm/companies.ts";
export {
  CONTRACT_EXPIRY_BATCH,
  crmMembersOf,
  endExpiredContracts,
  type EndedContract,
} from "./crm/contract-expiry.ts";
export {
  ADMIN_FOLDER_NAME,
  CONTRACT_PEOPLE_MAX,
  type InvalidPeople,
} from "./crm/contract-people.ts";
export type { CrmContractSigner, CrmContractSigning } from "./crm/contract-progress.ts";
export type { SignedCopyInput } from "./crm/contract-signed-copy.ts";
export {
  CONTRACT_SETTLE_BATCH,
  settleSentContracts,
  type ContractToSend,
  type SendRefusal,
  type SentResult,
  type SettledContract,
} from "./crm/contract-signing.ts";
export {
  changeContract,
  type ContractChange,
  type ContractSigned,
  type ContractState,
  type ContractStatus,
  type ContractTransition,
  type InvalidContract,
  type InvalidTransition,
} from "./crm/contract-status.ts";
export type {
  ContractInput,
  ContractListResult,
  ContractPatch,
  ContractResult,
  CrmContract,
  ContractSignedBy,
  CrmContractRow,
  ListContractsInput,
  SignatureOpen,
} from "./crm/contracts.ts";
export type { CrmNameCursor, CrmRecordRef, Forbidden, NoCrm, NotFound } from "./crm/core.ts";
export type {
  DealDetailResult,
  DealInput,
  DealPatch,
  DealResult,
  InvalidCurrency,
  InvalidValue,
  ListDealsInput,
  WriteDealResult,
} from "./crm/deals.ts";
export { FILE_LINKS_MAX, type CrmFileLink, type FileLinkRecord } from "./crm/files.ts";
export { CRM_ROOT_FOLDER_NAME, type DealFolderResult, type FolderResult } from "./crm/folders.ts";
export {
  CRM_NOTE_MAX_LENGTH,
  type CrmEvent,
  type CrmNote,
  type CrmTimelineCursor,
  type InvalidBody,
  type NoteResult,
  type TimelinePage,
  type TimelineResult,
} from "./crm/notes.ts";
export type {
  AddPersonInput,
  AddPersonResult,
  AddressTaken,
  InvalidAddress,
  ListPeopleInput,
  PersonResult,
  UpdatePersonInput,
  UpdatePersonResult,
} from "./crm/people.ts";
export {
  PROJECT_ACCESS_MAX,
  type AlreadyTeammate,
  type CrmProjectAccess,
  type GrantAccessResult,
  type InvalidEmail,
  type ProjectScope,
  type SharingRefused,
  type TooMany,
} from "./crm/access.ts";
export {
  CRM_PLAN_DESCRIPTION_MAX,
  CRM_PLAN_MAX,
  CRM_PLAN_TITLE_MAX,
  type CrmDeliverable,
  type CrmMilestone,
  type CrmPlan,
  type DeliverableInput,
  type DeliverablePatch,
  type DeliverableResult,
  type DeliverableStatus,
  type MilestoneInput,
  type MilestonePatch,
  type MilestoneResult,
  type MilestoneStatus,
} from "./crm/plan.ts";
export type {
  NotInReview,
  NoteRequired,
  PortalContract,
  PortalDeliverable,
  PortalFile,
  PortalProject,
  PortalProjectDetail,
  ReviewDecision,
} from "./crm/portal.ts";
export type { CrmCompany, CrmDeal, CrmPerson, CrmPersonAddress } from "./crm/records.ts";
export {
  LOOKUP_MAX_ADDRESSES,
  SEARCH_LIMIT,
  type CrmLookupResult,
  type CrmSearchResult,
} from "./crm/search.ts";
export type { CrmSettings } from "./crm/settings.ts";
export {
  STAGE_KINDS,
  STARTING_STAGES,
  type CrmStage,
  type ReplaceStagesResult,
  type StageInput,
} from "./crm/stages.ts";
export {
  type CrmSubtask,
  type CrmTask,
  type CrmTaskCursor,
  type InvalidAssignee,
  type InvalidTitle,
  type ListTasksInput,
  type TaskInput,
  type TaskPatch,
  type TaskResult,
} from "./crm/tasks.ts";
export {
  enterFirstStage,
  moveDealStage,
  type DealStageState,
  type DealStageTransition,
  type StageKind,
  type StageTarget,
} from "./crm/stage-transition.ts";

const isFreelancer = (member: CrmMember): member is Freelancer => member.projects !== null;

/**
 * The member door. Every record of the member's company workspace, read and written by every
 * teammate; deleting for good and editing stages are for owners and admins. A freelancer
 * reaches only their projects (`docs/spec/crm.md`, "Project access"): each operation names the
 * gate it opens to them, and one that names none answers them `not_found`. Nothing reaches
 * another workspace, and in a Personal space every call answers `{ status: "no_crm" }`.
 */
export function memberCrm(db: Db, memberId: string) {
  const door: CrmDoor = { db, memberId };
  return {
    listCompanies: (input: ListCompaniesInput = {}) =>
      asMember(door, (m, ex) => listCompanies(ex, m, input)),
    company: (id: string) => asMember(door, (m, ex) => getCompany(ex, m, id)),
    createCompany: (input: Parameters<typeof createCompany>[2]) =>
      writeAsMember(door, (m, tx) => createCompany(tx, m, input)),
    updateCompany: (id: string, patch: CompanyPatch) =>
      writeAsMember(door, (m, tx) => updateCompany(tx, m, id, patch)),
    changeCompany: (id: string, change: CompanyChange) =>
      writeAsMember(door, (m, tx) => changeCompany(tx, m, id, change)),
    archiveCompany: (id: string) => writeAsMember(door, (m, tx) => archiveCompany(tx, m, id)),
    restoreCompany: (id: string) => writeAsMember(door, (m, tx) => restoreCompany(tx, m, id)),
    deleteCompany: (id: string) => writeAsMember(door, (m, tx) => deleteCompany(tx, m, id)),
    addCompanyDomain: (id: string, domain: string) =>
      writeAsMember(door, (m, tx) => addCompanyDomain(tx, m, id, domain)),
    removeCompanyDomain: (id: string, domain: string) =>
      writeAsMember(door, (m, tx) => removeCompanyDomain(tx, m, id, domain)),

    listPeople: (input: ListPeopleInput = {}) =>
      asMember(door, (m, ex) => listPeople(ex, m, input)),
    person: (id: string) => asMember(door, (m, ex) => getPerson(ex, m, id)),
    personDetail: (id: string) => asMember(door, (m, ex) => getPersonDetail(ex, m, id)),
    addPerson: (input: AddPersonInput) => writeAsMember(door, (m, tx) => addPerson(tx, m, input)),
    updatePerson: (id: string, patch: UpdatePersonInput) =>
      writeAsMember(door, (m, tx) => updatePerson(tx, m, id, patch)),
    archivePerson: (id: string) => writeAsMember(door, (m, tx) => archivePerson(tx, m, id)),
    restorePerson: (id: string) => writeAsMember(door, (m, tx) => restorePerson(tx, m, id)),
    deletePerson: (id: string) => writeAsMember(door, (m, tx) => deletePerson(tx, m, id)),

    listDeals: (input: ListDealsInput = {}) =>
      asMember(
        door,
        (m, ex) => (isFreelancer(m) ? freelancerDeals(ex, m, input) : listDeals(ex, m, input)),
        ANYONE,
      ),
    deal: (id: string) =>
      asMember(
        door,
        (m, ex) => (isFreelancer(m) ? freelancerDeal(ex, m, id) : getDeal(ex, m, id)),
        onProject(id),
      ),
    createDeal: (input: DealInput) => writeAsMember(door, (m, tx) => createDeal(tx, m, input)),
    updateDeal: (id: string, patch: DealPatch) =>
      writeAsMember(door, (m, tx) => updateDeal(tx, m, id, patch)),
    setDealIcon: (id: string, iconId: string | null) =>
      writeAsMember(door, (m, tx) => setDealIcon(tx, m, id, iconId)),
    moveDeals: (input: { dealIds: string[]; stageId: string }) =>
      writeAsMember(door, (m, tx) => moveDeals(tx, m, input)),
    archiveDeal: (id: string) => writeAsMember(door, (m, tx) => archiveDeal(tx, m, id)),
    restoreDeal: (id: string) => writeAsMember(door, (m, tx) => restoreDeal(tx, m, id)),
    bulk: (records: CrmBulkRecords, ids: string[], action: CrmBulkAction) =>
      bulkCrm(door, records, ids, action),
    deleteDeal: (id: string) => writeAsMember(door, (m, tx) => deleteDeal(tx, m, id)),

    companyFolder: (id: string) => writeAsMember(door, (m, tx) => companyFolder(tx, m, id)),
    dealFolder: (id: string) =>
      writeAsMember(door, (m, tx) => dealFolder(tx, m, id), onProject(id)),
    fileLinks: (record: FileLinkRecord) =>
      asMember(door, (m, ex) => fileLinksOf(ex, m, record), onProjectRecord(record)),
    linkFiles: (record: FileLinkRecord, nodeIds: string[]) =>
      writeAsMember(door, (m, tx) => linkFiles(tx, m, record, nodeIds), onProjectRecord(record)),
    unlinkFile: (record: FileLinkRecord, nodeId: string) =>
      writeAsMember(door, (m, tx) => unlinkFile(tx, m, record, nodeId), onProjectRecord(record)),

    listContracts: (input: ListContractsInput) =>
      asMember(
        door,
        (m, ex) => listContracts(ex, m, isFreelancer(m) ? { ...input, involving: m.id } : input),
        "dealId" in input ? onProject(input.dealId) : TEAM_ONLY,
      ),
    createContract: (input: ContractInput) =>
      writeAsMember(door, (m, tx) => createContract(tx, m, input)),
    updateContract: (id: string, patch: ContractPatch) =>
      writeAsMember(door, (m, tx) => updateContract(tx, m, id, patch)),
    deleteContract: (id: string) => writeAsMember(door, (m, tx) => deleteContract(tx, m, id)),
    recordSignedCopy: (id: string, input: SignedCopyInput) =>
      writeAsMember(door, (m, tx) => recordSignedCopy(tx, m, id, input)),
    contractToSend: (id: string) => asMember(door, (m, ex) => contractToSend(ex, m, id)),
    markContractSent: (id: string, request: Parameters<typeof markContractSent>[3]) =>
      writeAsMember(door, (m, tx) => markContractSent(tx, m, id, request)),
    contractOpenRequest: (id: string) => asMember(door, (m, ex) => openRequestOf(ex, m, id)),
    withdrawContract: (id: string, requestId: string) =>
      writeAsMember(door, (m, tx) => withdrawContract(tx, m, id, requestId)),

    stages: () =>
      asMember(
        door,
        async (m, ex) => ({ status: "ok" as const, stages: await stagesOf(ex, m.orgId) }),
        ANYONE,
      ),
    replaceStages: (input: StageInput[]) =>
      writeAsMember(door, (m, tx) => replaceStages(tx, m, input)),
    settings: () => asMember(door, (m, ex) => getSettings(ex, m), ANYONE),
    audience: () => asMember(door, (m, ex) => crmAudience(ex, m), ANYONE),
    putSettings: (input: { defaultCurrency: string | null }) =>
      writeAsMember(door, (m, tx) => putSettings(tx, m, input)),

    createNote: (input: { record: CrmRecordRef; body: string }) =>
      writeAsMember(door, (m, tx) => createNote(tx, m, input), onProjectRecord(input.record)),
    updateNote: (id: string, input: { body: string }) =>
      writeAsMember(door, (m, tx) => updateNote(tx, m, id, input), noteOnProject(id)),
    deleteNote: (id: string) =>
      writeAsMember(door, (m, tx) => deleteNote(tx, m, id), noteOnProject(id)),
    events: (record: CrmRecordRef, page: TimelinePage = {}) =>
      asMember(
        door,
        (m, ex) => eventsOf(ex, m, record, page, isFreelancer(m) ? freelancerEvents : undefined),
        onProjectRecord(record),
      ),
    notes: (record: CrmRecordRef, page: TimelinePage = {}) =>
      asMember(
        door,
        (m, ex) => notesOf(ex, m, record, page, isFreelancer(m) ? freelancerNotes : undefined),
        onProjectRecord(record),
      ),

    listTasks: (input: ListTasksInput = {}) =>
      asMember(
        door,
        (m, ex) => (isFreelancer(m) ? freelancerTasks(ex, m, input) : listTasks(ex, m, input)),
        ANYONE,
      ),
    taskCounts: () => asMember(door, (m, ex) => countTasks(ex, m)),
    task: (id: string) => asMember(door, (m, ex) => getTask(ex, m, id), taskOnProject(id)),
    createTask: (input: TaskInput) =>
      writeAsMember(door, (m, tx) => createTask(tx, m, input), onProjectRecord(input.record)),
    updateTask: (id: string, patch: TaskPatch) =>
      writeAsMember(door, (m, tx) => updateTask(tx, m, id, patch), taskChangeOnProject(id, patch)),
    deleteTask: (id: string) =>
      writeAsMember(door, (m, tx) => deleteTask(tx, m, id), taskOnProject(id)),

    plan: (dealId: string) => asMember(door, (m, ex) => getPlan(ex, m, dealId), onProject(dealId)),
    createMilestone: (dealId: string, input: MilestoneInput) =>
      writeAsMember(door, (m, tx) => createMilestone(tx, m, dealId, input), onProject(dealId)),
    updateMilestone: (id: string, patch: MilestonePatch) =>
      writeAsMember(door, (m, tx) => updateMilestone(tx, m, id, patch), milestoneOnProject(id)),
    deleteMilestone: (id: string) =>
      writeAsMember(door, (m, tx) => deleteMilestone(tx, m, id), milestoneOnProject(id)),
    createDeliverable: (dealId: string, input: DeliverableInput) =>
      writeAsMember(door, (m, tx) => createDeliverable(tx, m, dealId, input), onProject(dealId)),
    updateDeliverable: (id: string, patch: DeliverablePatch) =>
      writeAsMember(door, (m, tx) => updateDeliverable(tx, m, id, patch), deliverableOnProject(id)),
    deleteDeliverable: (id: string) =>
      writeAsMember(door, (m, tx) => deleteDeliverable(tx, m, id), deliverableOnProject(id)),

    projectAccess: (dealId: string) => asMember(door, (m, ex) => listAccess(ex, m, dealId)),
    grantProjectAccess: (dealId: string, input: { email: string; scope: ProjectScope }) =>
      writeAsMember<GrantAccessResult>(door, (m, tx) => grantAccess(tx, m, dealId, input)),
    revokeProjectAccess: (dealId: string, email: string) =>
      writeAsMember(door, (m, tx) => revokeAccess(tx, m, dealId, email)),

    search: (input: { q: string; limit?: number }) =>
      asMember(
        door,
        (m, ex) => (isFreelancer(m) ? freelancerSearch(ex, m, input) : searchCrm(ex, m, input)),
        ANYONE,
      ),
    lookup: (input: { addresses: string[] }) =>
      asMember(
        door,
        (m, ex) => (isFreelancer(m) ? freelancerLookup(ex, m, input) : lookupCrm(ex, m, input)),
        ANYONE,
      ),
  };
}

/**
 * The client door: what a person outside the workspace sees of its CRM, by address. The projects
 * they were added to as a client, each with its plan's milestones, the deliverables shown to them,
 * its sent and signed contracts and its `Client` folder (`docs/spec/crm.md`, "Client portal").
 */
export function userCrm(db: Db, userId: string, scopeOrgId?: string | null) {
  const person: PortalPerson = { db, userId, scopeOrgId };
  return {
    projects: () => portalProjects(person),
    project: (dealId: string) => portalProject(person, dealId),
    reviewDeliverable: (
      dealId: string,
      id: string,
      input: { decision: ReviewDecision; note?: string | null },
    ) => reviewDeliverable(person, dealId, id, input),
  };
}

export type MemberCrm = ReturnType<typeof memberCrm>;
export type UserCrm = ReturnType<typeof userCrm>;
