import type { Db } from "./client.ts";
import { memberMail, userMail } from "./mail.ts";
import { memberCrm, userCrm } from "./crm.ts";
import { memberCalendar, userCalendar } from "./calendar.ts";
import { memberStorage, userStorage } from "./storage.ts";
import { memberTalk } from "./talk.ts";
import { memberMeetings, userMeetings } from "./meetings.ts";

/** Everything a member of one workspace may read and change, module by module. */
export function forMember(db: Db, memberId: string) {
  return {
    ...memberMail(db, memberId),
    storage: memberStorage(db, memberId),
    crm: memberCrm(db, memberId),
    calendar: memberCalendar(db, memberId),
    talk: memberTalk(db, memberId),
    meetings: memberMeetings(db, memberId),
  };
}

/**
 * What a person reaches across every workspace they belong to, or only `scopeOrgId`'s
 * (a session opened with a company's address).
 */
export function forUser(db: Db, userId: string, scopeOrgId?: string | null) {
  return {
    ...userMail(db, userId, scopeOrgId),
    storage: userStorage(db, userId, scopeOrgId),
    crm: userCrm(db, userId, scopeOrgId),
    calendar: userCalendar(db, userId, scopeOrgId),
    meetings: userMeetings(db, userId, scopeOrgId),
  };
}
