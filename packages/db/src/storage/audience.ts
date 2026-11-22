import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { userEmails } from "../schema/identity.ts";
import { storageGrants } from "../schema/storage.ts";
import { shareableChain } from "./access.ts";
import { chainOf } from "./core.ts";
import { teamspaceAudience } from "./teamspaces.ts";

/**
 * The members of a file's workspace told what happens to it live (who edits it, a live
 * document's changes) when it is in a teamspace: everyone who reaches the teamspace, and the
 * members a grant on the file or a folder above it is addressed to.
 */
export async function teamspaceFileAudience(ex: Db, nodeId: string) {
  const chain = await chainOf(ex, nodeId);
  const node = chain?.[0];
  if (!chain || !node?.teamspaceId) return [];
  const reaching = await teamspaceAudience(ex, node.teamspaceId);
  const grants = await ex
    .select({ email: storageGrants.email })
    .from(storageGrants)
    .where(
      inArray(
        storageGrants.nodeId,
        shareableChain(chain).map((row) => row.id),
      ),
    );
  const addresses = [...new Set(grants.map((grant) => grant.email.toLowerCase()))];
  if (addresses.length === 0) return reaching;
  const granted = await ex
    .selectDistinct({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(userEmails, eq(userEmails.userId, users.id))
    .where(
      and(
        eq(members.organizationId, node.orgId),
        or(
          and(inArray(sql`lower(${users.email})`, addresses), eq(users.emailVerified, true)),
          inArray(sql`lower(${userEmails.email})`, addresses),
        ),
      ),
    );
  return [...new Set([...reaching, ...granted.map((row) => row.id)])];
}
