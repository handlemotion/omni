// The doors (ADR 0005, ADR 0034, ADR 0035): the only way routes reach a module's rows. Each module
// adds one property here, built by its own surface file, which decides access itself. Mail
// predates that and is spread at the top level.
import type { Db } from "./client.ts";
import { memberMail, userMail } from "./mail.ts";
import { memberCrm, userCrm } from "./crm.ts";
import { memberStorage, userStorage } from "./storage.ts";

/** Everything a member of one workspace may read and change, module by module. */
export function forMember(db: Db, memberId: string) {
  return {
    ...memberMail(db, memberId),
    /** The member door to Storage (ADR 0034): their My files and, in a company, Shared. */
    storage: memberStorage(db, memberId),
    /** The member door to the CRM (ADR 0036): every record of their company workspace. */
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
    /** The grant door to Storage (ADR 0034): what was shared with an address they verified. */
    storage: userStorage(db, userId, scopeOrgId),
    /** The guest door to the CRM (ADR 0036): empty until ADR 0037 opens it. */
    crm: userCrm(db, userId, scopeOrgId),
  };
}
