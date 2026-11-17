import type { Db } from "./client.ts";
import { memberMail, userMail } from "./mail.ts";
import { memberCrm, userCrm } from "./crm.ts";
import { memberStorage, userStorage } from "./storage.ts";

/** Everything a member of one workspace may read and change, module by module. */
export function forMember(db: Db, memberId: string) {
  return {
    ...memberMail(db, memberId),
    storage: memberStorage(db, memberId),
    crm: memberCrm(db, memberId),
  };
}

/**
 * What a person reaches across every workspace they belong to (ADR 0014), or only `scopeOrgId`'s
 * (a session opened with a company's address, ADR 0024).
 */
export function forUser(db: Db, userId: string, scopeOrgId?: string | null) {
  return {
    ...userMail(db, userId, scopeOrgId),
    storage: userStorage(db, userId, scopeOrgId),
    crm: userCrm(db, userId, scopeOrgId),
  };
}
