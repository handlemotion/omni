// A login opens only the workspace it belongs to (ADR 0024 decision 3). Better Auth does not tell
// a session hook which address signed in, so each auth request runs in a small per-request store:
// the magic-link verify and the Google profile note the address there, and the session hooks read
// it to scope a session opened with a company's address to that company. Passkeys note nothing,
// so their sessions are unscoped.
import { AsyncLocalStorage } from "node:async_hooks";
import { companyForAddress, schema, scopeSession, sessionAccess, type Db } from "@omni/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";

interface SignIn {
  /** The address this request signs in with, as the person proved it. */
  address?: string;
  /** The company that address belongs to, once the session hook has looked. */
  scopeOrgId?: string | null;
}

const signIns = new AsyncLocalStorage<SignIn>();

/** Runs one auth request with its own sign-in store. The Worker wraps `auth.handler` in it. */
export function withSignInRequest<T>(run: () => T): T {
  return signIns.run({}, run);
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
export async function newSessionScope(db: Db): Promise<string | null> {
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

function refuse(message: string): never {
  throw new APIError("FORBIDDEN", { code: "SESSION_SCOPED", message });
}

/**
 * Sign-in methods a scoped session must not add: each would give whoever holds the company's
 * address a lasting way in that is not scoped (a passkey, a linked Google account, a new primary).
 * Extra sign-in emails are refused by the Worker's `/api/account` routes the same way.
 */
const NEW_SIGN_IN_METHODS = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/link-social",
  "/change-email",
]);

/** Organization endpoints a scoped session may not use at all. */
const REFUSED_ORGANIZATION_PATHS = new Set(["/organization/create", "/organization/delete"]);

/** Organization endpoints that list across every workspace the user is in. */
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

/**
 * Every organization a Better Auth organization request names, from its body or query: by id,
 * by slug, through an invitation or through a team. One it does not name is the active one, which
 * a scoped session keeps inside its scope.
 */
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
    // An unknown slug names nothing in scope: refused like any other.
    targets.push(org?.id ?? `slug:${slug}`);
  }
  // `get-invitation` takes the invitation's id as `id`.
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

/**
 * The scope of the request's session, or null when it is unscoped or signed out. A session
 * deleted since its cookie was cached is refused outright, as signed out.
 */
async function requestScope(db: Db, ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const session = await getSessionFromCtx(ctx);
  if (!session) return null;
  const access = await sessionAccess(db, session.session.id);
  if (!access) throw new APIError("UNAUTHORIZED", { message: "signed out" });
  return access.scopeOrgId;
}

/** Keeps only the rows of a user-wide list that belong to `scope`. */
function onlyInScope(returned: unknown, scope: string) {
  if (!Array.isArray(returned)) return returned;
  return returned.filter((row: { id?: string; organizationId?: string }) =>
    "organizationId" in row ? row.organizationId === scope : row.id === scope,
  );
}

/**
 * Keeps a scoped session inside its company through Better Auth's own endpoints (ADR 0024): every
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
