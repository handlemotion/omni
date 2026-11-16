// A company keeps its files when someone leaves (ADR 0034 decision 1). `storage_nodes` has no
// cascade from its owner, so before Better Auth deletes a member row their My files move to
// whoever removed them, or to the workspace's owner when they left by themselves.
import { handOverMemberStorage, schema, type Db } from "@omni/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { noteRequestActor, requestActor } from "./session-scope.ts";

const LEAVE = "/organization/leave";
const REMOVE_MEMBER = "/organization/remove-member";

async function memberOf(db: Db, userId: string, orgId: string) {
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(and(eq(schema.members.userId, userId), eq(schema.members.organizationId, orgId)));
  return member?.id ?? null;
}

/**
 * `organizationHooks.beforeRemoveMember`: runs once Better Auth has decided the removal is
 * allowed. The files go to the person removing, whom `storageHandover` noted for this request.
 */
export function handOverBeforeRemoval(db: Db) {
  return async ({ member }: { member: { id: string; organizationId: string } }) => {
    const actor = requestActor();
    await handOverMemberStorage(db, {
      memberId: member.id,
      toMemberId: actor ? await memberOf(db, actor, member.organizationId) : null,
    });
  };
}

/**
 * Leaving has no organization hook, so the hand-over runs ahead of the endpoint: a person only
 * ever leaves as themselves. A sole owner has nobody to hand to, nothing moves, and Better Auth
 * then refuses the leave. For a removal it only notes who is asking.
 */
export function storageHandover(db: Db) {
  return {
    id: "omni-storage-handover",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === LEAVE || ctx.path === REMOVE_MEMBER,
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            if (ctx.path === REMOVE_MEMBER) return noteRequestActor(session.user.id);
            const orgId = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId;
            if (typeof orgId !== "string") return;
            const memberId = await memberOf(db, session.user.id, orgId);
            if (memberId) await handOverMemberStorage(db, { memberId });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
