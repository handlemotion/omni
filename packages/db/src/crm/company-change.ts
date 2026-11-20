import {
  addCompanyDomain,
  archiveCompany,
  getCompany,
  removeCompanyDomain,
  restoreCompany,
  updateCompany,
  type CompanyDetailResult,
  type CompanyPatch,
  type DomainResult,
  type UpdateCompanyResult,
} from "./companies.ts";
import { refuse, type CrmMember, type Ex } from "./core.ts";

export interface CompanyChange {
  patch?: CompanyPatch;
  addDomains?: string[];
  removeDomains?: string[];
  /** True archives it, false restores it. */
  archived?: boolean;
}

const hasPatch = (patch: CompanyPatch) => Object.values(patch).some((value) => value !== undefined);

/**
 * Several changes to one company in one transaction: fields, then domains, then archive or
 * restore. The first refusal rolls every one of them back and is the answer.
 */
export const changeCompany: (
  tx: Ex,
  member: CrmMember,
  id: string,
  change: CompanyChange,
) => Promise<CompanyDetailResult | UpdateCompanyResult | DomainResult> = async (
  tx,
  member,
  id,
  change,
) => {
  if (change.patch && hasPatch(change.patch)) {
    const changed = await updateCompany(tx, member, id, change.patch);
    if (changed.status !== "ok") refuse(changed);
  }
  for (const domain of change.addDomains ?? []) {
    const added = await addCompanyDomain(tx, member, id, domain);
    if (added.status !== "ok") refuse(added);
  }
  for (const domain of change.removeDomains ?? []) {
    const removed = await removeCompanyDomain(tx, member, id, domain);
    if (removed.status !== "ok") refuse(removed);
  }
  if (change.archived !== undefined) {
    const moved = change.archived
      ? await archiveCompany(tx, member, id)
      : await restoreCompany(tx, member, id);
    if (moved.status !== "ok") refuse(moved);
  }
  return getCompany(tx, member, id);
};
