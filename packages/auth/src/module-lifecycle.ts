// What each module does when a member leaves or a workspace is deleted (ADR 0035 decision 3).
// Better Auth deletes the member and organization rows; a module whose rows would keep that
// delete from happening, or would be orphaned by it, registers a hook in the Worker's
// `modules.ts`, and this runs them in order. It names no module.
import type { Db } from "@omni/db";
import { schema } from "@omni/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { noteRequestActor, requestActor } from "./session-scope.ts";

/** A module's part in a member leaving and a workspace going. Each must be safe to run twice. */
export interface ModuleLifecycle {
  name: string;
  /**
   * Before a member row is deleted. `byMemberId` is who removed them, in the same workspace; null
   * when they left by themselves or the remover is not a member there.
   */
  memberRemoved?: (
    db: Db,
    input: { orgId: string; memberId: string; byMemberId: string | null },
  ) => Promise<unknown>;
  /** Before the workspace's members and the workspace itself are deleted. */
  workspaceDeleted?: (db: Db, input: { orgId: string }) => Promise<unknown>;
}

const LEAVE = "/organization/leave";
const REMOVE_MEMBER = "/organization/remove-member";

async function memberOf(db: Db, userId: string, orgId: string) {
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(and(eq(schema.members.userId, userId), eq(schema.members.organizationId, orgId)));
  return member?.id ?? null;
}

async function runMemberRemoved(
  db: Db,
  modules: readonly ModuleLifecycle[],
  input: { orgId: string; memberId: string; byMemberId: string | null },
) {
  for (const module of modules) await module.memberRemoved?.(db, input);
}

/**
 * `organizationHooks.beforeRemoveMember`: runs once Better Auth has decided the removal is
 * allowed, with the person removing, whom `moduleLifecycle` noted for this request.
 */
export function beforeRemoveMember(db: Db, modules: readonly ModuleLifecycle[]) {
  return async ({ member }: { member: { id: string; organizationId: string } }) => {
    const actor = requestActor();
    await runMemberRemoved(db, modules, {
      orgId: member.organizationId,
      memberId: member.id,
      byMemberId: actor ? await memberOf(db, actor, member.organizationId) : null,
    });
  };
}

/**
 * `organizationHooks.beforeDeleteOrganization`: runs once Better Auth has decided the workspace
 * may be deleted, and before it deletes the members.
 */
export function beforeDeleteWorkspace(db: Db, modules: readonly ModuleLifecycle[]) {
  return async ({ organization }: { organization: { id: string } }) => {
    for (const module of modules) await module.workspaceDeleted?.(db, { orgId: organization.id });
  };
}

/**
 * Leaving has no organization hook, so the member-removed hooks run ahead of the endpoint: a
 * person only ever leaves as themselves. If a module refuses nothing and Better Auth then
 * refuses the leave (a sole owner), each hook found nothing to do or is safe to have run. For a
 * removal it only notes who is asking.
 */
export function moduleLifecycle(db: Db, modules: readonly ModuleLifecycle[]) {
  return {
    id: "omni-module-lifecycle",
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
            if (memberId)
              await runMemberRemoved(db, modules, { orgId, memberId, byMemberId: null });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
