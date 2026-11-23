import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/index.ts";
import { conversationReadQueries } from "./conversation-reads.ts";
import { conversationViewQueries } from "./conversation-views.ts";
import { memberCrmSharing } from "./crm-sharing.ts";
import { grantScope, type IsGrantee } from "./grants.ts";
import { inboxReportQueries } from "./inbox-report.ts";
import { inboxViewQueries } from "./inbox-views.ts";
import { searchQueries } from "./mail-search.ts";
import { memberLookupQueries } from "./member-lookup.ts";
import { notificationFeedQueries } from "./notification-feed.ts";
import { threadDetailQueries } from "./thread-detail.ts";
import { participantQueries } from "./threads-with.ts";

/** The mail reads `forMember` and `forUser` share (`memberMail`, `userMail`). */
export type MemberQueries = ReturnType<typeof mailQueries>;

/**
 * Mail's member door: the only read path to mail data. Every query inner-joins `mailbox_access`
 * for this member and `members` to require the row's org to be the member's org, so a missing
 * grant or a grant that crosses orgs returns nothing. `forMember` spreads it.
 */
export function memberMail(db: Db, memberId: string) {
  return {
    ...mailQueries(db, (grantee) => sql`${grantee} = ${memberId}`),
    ...memberCrmSharing(db, memberId),
  };
}

/**
 * The same reads across every organization `userId` belongs to: the union of what
 * each of their members can see. Each row keeps its `org_id`, and per-member state (read, done,
 * Later) is the state of the member whose grant shows the row. The grant and org checks are
 * the ones `memberMail` runs, so a user sees exactly what their members can, and nothing else.
 * With `scopeOrgId` (a session opened with a company's address), only their member in
 * that organization counts. `forUser` spreads it.
 */
export function userMail(db: Db, userId: string, scopeOrgId?: string | null) {
  const inScope = scopeOrgId ? sql` and um.organization_id = ${scopeOrgId}` : sql``;
  return mailQueries(
    db,
    (grantee) =>
      sql`${grantee} in (select um.id from ${members} um where um.user_id = ${userId}${inScope})`,
  );
}

function mailQueries(db: Db, isGrantee: IsGrantee) {
  const scope = grantScope(db, isGrantee);
  return {
    ...participantQueries(db, isGrantee),
    ...inboxViewQueries(scope),
    ...threadDetailQueries(scope),
    ...conversationViewQueries(scope),
    ...conversationReadQueries(scope),
    ...inboxReportQueries(scope),
    ...memberLookupQueries(scope),
    ...notificationFeedQueries(scope),
    ...searchQueries(scope),
  };
}
