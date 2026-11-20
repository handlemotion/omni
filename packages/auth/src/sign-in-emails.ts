import { noteSignInAddress } from "./session-scope.ts";
import { findUserIdByExtraEmail, schema, type Db } from "@omni/db";
import type {
  AuthContext,
  BetterAuthPlugin,
  DBAdapter,
  DBTransactionAdapter,
  Where,
} from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, sql } from "drizzle-orm";

type AdapterFactory = ReturnType<typeof drizzleAdapter>;

function emailLookup(where: Where[] | undefined) {
  const [clause, ...rest] = where ?? [];
  if (!clause || rest.length > 0) return undefined;
  const operator = clause.operator ?? "eq";
  return clause.field === "email" && operator === "eq" && typeof clause.value === "string"
    ? clause.value
    : undefined;
}

/**
 * Every raw adapter lookup of a user by email (the organization plugin's "is this person already
 * a member" on invite) falls back to the verified extra addresses, so any of them finds the same
 * user. Transactions get the same wrapper, since Better Auth looks users up inside them too.
 * `internalAdapter.findUserByEmail` discards a user whose `email` differs from the one asked for,
 * so `withSignInEmails` below covers that path.
 */
export function resolveSignInEmails(factory: AdapterFactory, db: Db) {
  const withLookup = <A extends DBTransactionAdapter>(adapter: A) => {
    const result: A = {
      ...adapter,
      findOne: async (args: Parameters<DBTransactionAdapter["findOne"]>[0]) => {
        const found = await adapter.findOne(args);
        const email = args.model === "user" ? emailLookup(args.where) : undefined;
        if (found || email === undefined) return found;
        const userId = await findUserIdByExtraEmail(db, email);
        return userId
          ? adapter.findOne({ ...args, where: [{ field: "id", value: userId }] })
          : null;
      },
    };
    return result;
  };
  const wrap = (adapter: DBAdapter) =>
    ({
      ...withLookup(adapter),
      transaction: (callback) => adapter.transaction((trx) => callback(withLookup(trx))),
    }) satisfies DBAdapter;
  return ((options) => wrap(factory(options))) as AdapterFactory;
}

type InternalAdapter = AuthContext["internalAdapter"];
const WRAPPED = Symbol("omni-sign-in-emails");

const withSignInEmails: (internal: InternalAdapter, db: Db) => InternalAdapter = (internal, db) => {
  if ((internal as { [WRAPPED]?: true })[WRAPPED]) return internal;
  const findUserByEmail: InternalAdapter["findUserByEmail"] = async (email, options) => {
    noteSignInAddress(email);
    const found = await internal.findUserByEmail(email, options);
    if (found) return found;
    const userId = await findUserIdByExtraEmail(db, email);
    const owner = userId ? await internal.findUserById(userId) : null;
    return owner ? internal.findUserByEmail(owner.email, options) : null;
  };
  return Object.assign({ ...internal, findUserByEmail }, { [WRAPPED]: true as const });
};

function resolveSignInEmailsInContext(context: AuthContext, db: Db) {
  let current = withSignInEmails(context.internalAdapter, db);
  Object.defineProperty(context, "internalAdapter", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (next: InternalAdapter) => {
      current = withSignInEmails(next, db);
    },
  });
}

const INVITATION_PATHS = new Set([
  "/organization/get-invitation",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
]);

/**
 * The plugin half of sign-in by any verified address. `init` makes `internalAdapter.findUserByEmail` resolve extra
 * addresses. The hooks handle invitations: Better Auth lets only the user whose `users.email`
 * equals the invitation's address see, accept or decline it. Before those calls, an invitation
 * addressed to one of the signed-in user's verified extra emails is readdressed to their primary,
 * so it joins that user, not a new one. Only the address's verified owner can trigger this, and
 * it changes nothing else.
 */
export function signInEmails(db: Db) {
  return {
    id: "omni-sign-in-emails",
    init: (context) => {
      resolveSignInEmailsInContext(context, db);
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path !== undefined && INVITATION_PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const invitationId =
              (ctx.body as { invitationId?: unknown } | undefined)?.invitationId ??
              (ctx.query as { id?: unknown } | undefined)?.id;
            if (typeof invitationId !== "string") return;
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const [invitation] = await db
              .select({ email: schema.invitations.email })
              .from(schema.invitations)
              .where(
                and(
                  eq(schema.invitations.id, invitationId),
                  eq(schema.invitations.status, "pending"),
                ),
              );
            if (!invitation) return;
            const address = invitation.email.toLowerCase();
            if (address === session.user.email.toLowerCase()) return;
            if ((await findUserIdByExtraEmail(db, address)) !== session.user.id) return;
            await db
              .update(schema.invitations)
              .set({ email: session.user.email.toLowerCase() })
              .where(
                and(
                  eq(schema.invitations.id, invitationId),
                  eq(sql`lower(${schema.invitations.email})`, address),
                ),
              );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
