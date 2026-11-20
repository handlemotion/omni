import type { Db } from "./client.ts";
import {
  addCompanyDomain,
  archiveCompany,
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  removeCompanyDomain,
  updateCompany,
  type ListCompaniesInput,
} from "./crm/companies.ts";
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
  asMember,
  crmAudience,
  writeAsMember,
  type CrmDoor,
  type CrmRecordRef,
} from "./crm/core.ts";
import {
  archiveDeal,
  createDeal,
  deleteDeal,
  getDeal,
  listDeals,
  moveDeals,
  updateDeal,
  type DealInput,
  type DealPatch,
  type ListDealsInput,
} from "./crm/deals.ts";
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
  listPeople,
  updatePerson,
  type AddPersonInput,
  type ListPeopleInput,
  type UpdatePersonInput,
} from "./crm/people.ts";
import { lookupCrm, searchCrm } from "./crm/search.ts";
import { getSettings, putSettings } from "./crm/settings.ts";
import { replaceStages, stagesOf, type StageInput } from "./crm/stages.ts";

export type {
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
  ListContractsInput,
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
  enterFirstStage,
  moveDealStage,
  type DealStageState,
  type DealStageTransition,
  type StageKind,
  type StageTarget,
} from "./crm/stage-transition.ts";

/**
 * The member door. Every record of the member's company workspace, read and written by every
 * member; deleting for good and editing stages are for owners and admins. Nothing reaches
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
    updateCompany: (id: string, patch: Parameters<typeof updateCompany>[3]) =>
      writeAsMember(door, (m, tx) => updateCompany(tx, m, id, patch)),
    archiveCompany: (id: string) => writeAsMember(door, (m, tx) => archiveCompany(tx, m, id)),
    deleteCompany: (id: string) => writeAsMember(door, (m, tx) => deleteCompany(tx, m, id)),
    addCompanyDomain: (id: string, domain: string) =>
      writeAsMember(door, (m, tx) => addCompanyDomain(tx, m, id, domain)),
    removeCompanyDomain: (id: string, domain: string) =>
      writeAsMember(door, (m, tx) => removeCompanyDomain(tx, m, id, domain)),

    listPeople: (input: ListPeopleInput = {}) =>
      asMember(door, (m, ex) => listPeople(ex, m, input)),
    person: (id: string) => asMember(door, (m, ex) => getPerson(ex, m, id)),
    addPerson: (input: AddPersonInput) => writeAsMember(door, (m, tx) => addPerson(tx, m, input)),
    updatePerson: (id: string, patch: UpdatePersonInput) =>
      writeAsMember(door, (m, tx) => updatePerson(tx, m, id, patch)),
    archivePerson: (id: string) => writeAsMember(door, (m, tx) => archivePerson(tx, m, id)),
    deletePerson: (id: string) => writeAsMember(door, (m, tx) => deletePerson(tx, m, id)),

    listDeals: (input: ListDealsInput = {}) => asMember(door, (m, ex) => listDeals(ex, m, input)),
    deal: (id: string) => asMember(door, (m, ex) => getDeal(ex, m, id)),
    createDeal: (input: DealInput) => writeAsMember(door, (m, tx) => createDeal(tx, m, input)),
    updateDeal: (id: string, patch: DealPatch) =>
      writeAsMember(door, (m, tx) => updateDeal(tx, m, id, patch)),
    moveDeals: (input: { dealIds: string[]; stageId: string }) =>
      writeAsMember(door, (m, tx) => moveDeals(tx, m, input)),
    archiveDeal: (id: string) => writeAsMember(door, (m, tx) => archiveDeal(tx, m, id)),
    deleteDeal: (id: string) => writeAsMember(door, (m, tx) => deleteDeal(tx, m, id)),

    companyFolder: (id: string) => writeAsMember(door, (m, tx) => companyFolder(tx, m, id)),
    dealFolder: (id: string) => writeAsMember(door, (m, tx) => dealFolder(tx, m, id)),

    listContracts: (input: ListContractsInput) =>
      asMember(door, (m, ex) => listContracts(ex, m, input)),
    createContract: (input: ContractInput) =>
      writeAsMember(door, (m, tx) => createContract(tx, m, input)),
    updateContract: (id: string, patch: ContractPatch) =>
      writeAsMember(door, (m, tx) => updateContract(tx, m, id, patch)),
    deleteContract: (id: string) => writeAsMember(door, (m, tx) => deleteContract(tx, m, id)),

    stages: () =>
      asMember(door, async (m, ex) => ({
        status: "ok" as const,
        stages: await stagesOf(ex, m.orgId),
      })),
    replaceStages: (input: StageInput[]) =>
      writeAsMember(door, (m, tx) => replaceStages(tx, m, input)),
    settings: () => asMember(door, (m, ex) => getSettings(ex, m)),
    audience: () => asMember(door, (m, ex) => crmAudience(ex, m)),
    putSettings: (input: { defaultCurrency: string | null }) =>
      writeAsMember(door, (m, tx) => putSettings(tx, m, input)),

    createNote: (input: { record: CrmRecordRef; body: string }) =>
      writeAsMember(door, (m, tx) => createNote(tx, m, input)),
    updateNote: (id: string, input: { body: string }) =>
      writeAsMember(door, (m, tx) => updateNote(tx, m, id, input)),
    deleteNote: (id: string) => writeAsMember(door, (m, tx) => deleteNote(tx, m, id)),
    events: (record: CrmRecordRef, page: TimelinePage = {}) =>
      asMember(door, (m, ex) => eventsOf(ex, m, record, page)),
    notes: (record: CrmRecordRef, page: TimelinePage = {}) =>
      asMember(door, (m, ex) => notesOf(ex, m, record, page)),

    search: (input: { q: string; limit?: number }) =>
      asMember(door, (m, ex) => searchCrm(ex, m, input)),
    lookup: (input: { addresses: string[] }) => asMember(door, (m, ex) => lookupCrm(ex, m, input)),
  };
}

/**
 * The guest door: what a person outside the workspace may see of its CRM, by address. Empty in
 * v1; the client dashboard will open it for a client's own deals.
 */
export function userCrm(_db: Db, _userId: string, _scopeOrgId?: string | null) {
  return {};
}

export type MemberCrm = ReturnType<typeof memberCrm>;
export type UserCrm = ReturnType<typeof userCrm>;
