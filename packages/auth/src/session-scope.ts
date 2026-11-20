import { AsyncLocalStorage } from "node:async_hooks";
import { companyForAddress, schema, scopeSession, sessionAccess, type Db } from "@omni/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";

interface SignIn {
  address?: string;
  scopeOrgId?: string | null;
  actorUserId?: string;
}

const signIns = new AsyncLocalStorage<SignIn>();

/** Runs one auth request with its own sign-in store. The Worker wraps `auth.handler` in it. */
export function withSignInRequest<T>(run: () => T) {
  return signIns.run({}, run) satisfies T;
}

/** Notes the address the current auth request signs in with. Outside a request, nothing. */
export function noteSignInAddress(address: string | undefined | null) {
  const store = signIns.getStore();
  if (store && address) store.address = address.toLowerCase();
}

/**
 * For `session.create.before`: the company this new session is scoped to, or null. Remembered
 * for `recordSessionScope`, which runs once the session has its id.
 */
export async function newSessionScope(db: Db) {
  const store = signIns.getStore();
  if (!store?.address) return null;
  store.scopeOrgId = await companyForAddress(db, store.address);
  return store.scopeOrgId;
}

/** For `session.create.after`: records the scope `newSessionScope` found, if any. */
export async function recordSessionScope(db: Db, sessionId: string) {
  const orgId = signIns.getStore()?.scopeOrgId;
  if (orgId) await scopeSession(db, sessionId, orgId);
}

/** Notes who the current auth request acts as. Outside a request, nothing. */
export function noteRequestActor(userId: string) {
  const store = signIns.getStore();
  if (store) store.actorUserId = userId;
}

/** Who the current auth request acts as, when a hook noted it. */
export function requestActor() {
  return signIns.getStore()?.actorUserId;
}

function refuse(message: string): never {
  throw new APIError("FORBIDDEN", { code: "SESSION_SCOPED", message });
}

const NEW_SIGN_IN_METHODS = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/link-social",
  "/change-email",
]);

const REFUSED_ORGANIZATION_PATHS = new Set(["/organization/create", "/organization/delete"]);

const USER_WIDE_LISTS = new Set([
  "/organization/list",
  "/organization/list-user-invitations",
  "/organization/list-user-teams",
]);

type Selectors = {
  organizationId?: unknown;
  organizationSlug?: unknown;
  invitationId?: unknown;
  teamId?: unknown;
  id?: unknown;
};

async function targetOrganizations(db: Db, path: string, selectors: Selectors) {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const targets: string[] = [];
  const orgId = text(selectors.organizationId);
  if (orgId) targets.push(orgId);
  const slug = text(selectors.organizationSlug);
  if (slug) {
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    targets.push(org?.id ?? `slug:${slug}`);
  }
  const invitationId =
    text(selectors.invitationId) ?? (path.endsWith("-invitation") ? text(selectors.id) : undefined);
  if (invitationId) {
    const [invitation] = await db
      .select({ orgId: schema.invitations.organizationId })
      .from(schema.invitations)
      .where(eq(schema.invitations.id, invitationId));
    if (invitation) targets.push(invitation.orgId);
  }
  const teamId = text(selectors.teamId);
  if (teamId) {
    for (const id of teamId.split(",")) {
      const [team] = await db
        .select({ orgId: schema.teams.organizationId })
        .from(schema.teams)
        .where(eq(schema.teams.id, id));
      if (team) targets.push(team.orgId);
    }
  }
  return targets;
}

async function requestScope(db: Db, ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const session = await getSessionFromCtx(ctx);
  if (!session) return null;
  const access = await sessionAccess(db, session.session.id);
  if (!access) throw new APIError("UNAUTHORIZED", { message: "signed out" });
  return access.scopeOrgId;
}

function onlyInScope(returned: unknown, scope: string) {
  if (!Array.isArray(returned)) return returned;
  return returned.filter((row: { id?: string; organizationId?: string }) =>
    "organizationId" in row ? row.organizationId === scope : row.id === scope,
  );
}

/**
 * Keeps a scoped session inside its company through Better Auth's own endpoints: every
 * organization request must name only that company, it cannot create or delete one, the lists
 * that span every workspace show only that company, and it cannot add a sign-in method.
 */
export function sessionScopeGuard(db: Db) {
  return {
    id: "omni-session-scope",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path !== undefined &&
            (ctx.path.startsWith("/organization/") || NEW_SIGN_IN_METHODS.has(ctx.path)),
          handler: createAuthMiddleware(async (ctx) => {
            const scope = await requestScope(db, ctx);
            if (!scope) return;
            if (NEW_SIGN_IN_METHODS.has(ctx.path)) {
              refuse("signed in with a work address: sign in another way to add a sign-in method");
            }
            if (REFUSED_ORGANIZATION_PATHS.has(ctx.path)) {
              refuse("signed in with a work address: sign in another way to do this");
            }
            const selectors = { ...(ctx.query as Selectors), ...(ctx.body as Selectors) };
            const targets = await targetOrganizations(db, ctx.path, selectors);
            if (targets.some((orgId) => orgId !== scope)) {
              refuse("signed in with a work address: only that workspace opens");
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path !== undefined && USER_WIDE_LISTS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const scope = await requestScope(db, ctx);
            if (scope) ctx.context.returned = onlyInScope(ctx.context.returned, scope);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/**
 * Before a company is deleted, its scoped sessions end: their scope row would go with it, and a
 * session with no scope reads as unscoped.
 */
export async function endScopedSessions(db: Db, orgId: string) {
  await db
    .delete(schema.sessions)
    .where(
      inArray(
        schema.sessions.id,
        db
          .select({ id: schema.sessionScopes.sessionId })
          .from(schema.sessionScopes)
          .where(eq(schema.sessionScopes.orgId, orgId)),
      ),
    );
}
