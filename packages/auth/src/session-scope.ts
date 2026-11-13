// A login opens only the workspace it belongs to (ADR 0024 decision 3). Better Auth does not tell
// a session hook which address signed in, so each auth request runs in a small per-request store:
// the magic-link verify and the Google profile note the address there, and the session hooks read
// it to scope a session opened with a company's address to that company. Passkeys note nothing,
// so their sessions are unscoped.
import { AsyncLocalStorage } from "node:async_hooks";
import { companyForAddress, schema, scopeSession, sessionScope, type Db } from "@omni/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";

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

const ORGANIZATION_PATHS = new Set([
  "/organization/set-active",
  "/organization/create",
  "/organization/accept-invitation",
]);

/**
 * Keeps a scoped session inside its company through Better Auth's own endpoints: it cannot make
 * another organization active, create one, join another by invitation, or add a sign-in method.
 */
export function sessionScopeGuard(db: Db) {
  return {
    id: "omni-session-scope",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path !== undefined &&
            (ORGANIZATION_PATHS.has(ctx.path) || NEW_SIGN_IN_METHODS.has(ctx.path)),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const scope = await sessionScope(db, session.session.id);
            if (!scope) return;
            if (NEW_SIGN_IN_METHODS.has(ctx.path)) {
              refuse("signed in with a work address: sign in another way to add a sign-in method");
            }
            const body = (ctx.body ?? {}) as { organizationId?: unknown; invitationId?: unknown };
            if (ctx.path === "/organization/create") {
              refuse("signed in with a work address: sign in another way to create a workspace");
            }
            if (ctx.path === "/organization/set-active") {
              if (body.organizationId && body.organizationId !== scope) {
                refuse("signed in with a work address: only that workspace opens");
              }
              return;
            }
            if (typeof body.invitationId !== "string") return;
            const [invitation] = await db
              .select({ orgId: schema.invitations.organizationId })
              .from(schema.invitations)
              .where(eq(schema.invitations.id, body.invitationId));
            if (invitation && invitation.orgId !== scope) {
              refuse("signed in with a work address: sign in another way to join this workspace");
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
