import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { stripe, type StripeOptions } from "@better-auth/stripe";
import type { Db } from "@omni/db";
import {
  advanceOrgSetup,
  findEmailOwner,
  isCompany,
  schema,
  claimInvitationInboxes,
  notifyMemberJoined,
  syncTeamMailboxAccess,
  teamMailbox,
} from "@omni/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { billingConfig, billingFields, checkBillingEnv, optionalText } from "./billing-env.ts";
import { type BillingLog, cancelDuplicateSubscriptions } from "./one-subscription.ts";
import { resolveSignInEmails, signInEmails } from "./sign-in-emails.ts";
import {
  beforeDeleteWorkspace,
  beforeRemoveMember,
  moduleLifecycle,
  type ModuleLifecycle,
} from "./module-lifecycle.ts";
import { ensurePersonalSpaceQuietly, personalSpaceHooks } from "./personal-space.ts";
import { mcpPlugins } from "./mcp.ts";
import {
  newSessionScope,
  noteSignInAddress,
  recordSessionScope,
  sessionScopeGuard,
} from "./session-scope.ts";
import { refreshSessionCacheOnOrgChange } from "./session-cache.ts";
import { magicLink } from "better-auth/plugins/magic-link";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import Stripe from "stripe";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

export type MagicLinkSender = (message: { email: string; url: string }) => Promise<void>;

export interface InvitationMessage {
  invitationId: string;
  email: string;
  /** `<WEB_APP_URL>/invite/<invitationId>`: the web app's accept page. */
  url: string;
  organizationName: string;
  inviterName: string;
  expiresAt: Date;
}

export type InvitationSender = (message: InvitationMessage) => Promise<void>;

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

/** Auth variables, documented in `packages/auth/.env.example`. */
export const authEnvSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    AUTH_TRUSTED_ORIGINS: commaList,
    AUTH_PASSKEY_RP_ID: optionalText,
    APP_NAME: optionalText,
    WEB_APP_URL: optionalText.pipe(z.url().optional()),
    /** Google OAuth client. Both set turns on "Sign in with Google"; neither leaves it off. */
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    /**
     * Who may have an account (ADR 0018). `open` (default): anyone with a verified email signs up
     * and creates their own workspace in onboarding. `invitation`: sign-up needs a pending
     * invitation, and only people who already own a workspace create another (the first comes
     * from the `org:create` CLI).
     */
    SIGN_UP: optionalText.pipe(z.enum(["open", "invitation"]).default("open")),
    /**
     * Hosts whose OAuth client metadata documents agents may sign in with (ADR 0029). Empty:
     * Claude's and ChatGPT's (`claude.ai`, `chatgpt.com`).
     */
    MCP_CIMD_HOSTS: commaList,
    ...billingFields,
  })
  .refine((env) => !env.GOOGLE_CLIENT_ID === !env.GOOGLE_CLIENT_SECRET, {
    path: ["GOOGLE_CLIENT_SECRET"],
    message: "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither",
  })
  .superRefine(checkBillingEnv)
  .transform((env) => ({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    passkeyRpId: env.AUTH_PASSKEY_RP_ID,
    appName: env.APP_NAME ?? "Omni",
    /** Origin of the web app; invitation links point here. Same origin as the API by default. */
    webAppURL: env.WEB_APP_URL ?? env.BETTER_AUTH_URL,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    signUp: env.SIGN_UP,
    cimdHosts: env.MCP_CIMD_HOSTS,
    billing: billingConfig(env),
  }));

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Validates auth config from the environment at startup; throws listing every bad variable. */
export function parseAuthEnv(env: Record<string, unknown>): AuthConfig {
  return authEnvSchema.parse(env);
}

export type SignUp = AuthConfig["signUp"];

/** Present only when billing is on (`STRIPE_SECRET_KEY` and friends set). */
export type BillingConfig = NonNullable<AuthConfig["billing"]>;

/**
 * The one plan's key, as the Stripe plugin stores it in `subscriptions.plan`. What customers see
 * (Checkout, the portal, invoices) is the Stripe product's name, set in Stripe.
 */
export const PLAN_NAME = "omnipresent";

/** Who may start checkout or open the portal for a workspace. */
export const BILLING_ROLES = ["owner", "admin"] as const;

/** A Stripe client that works on Workers (fetch, Web Crypto) and in Node. */
export function createStripeClient(secretKey: string) {
  return new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

/** Whether `userId` is an owner or admin of `orgId`: the people who manage its billing. */
export async function mayManageBilling(db: Db, userId: string, orgId: string) {
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        eq(schema.members.organizationId, orgId),
        inArray(schema.members.role, [...BILLING_ROLES]),
      ),
    )
    .limit(1);
  return member !== undefined;
}

/**
 * Better Auth's Stripe plugin for one plan billed to the organization (ADR 0015). Checkout is
 * only for paying: free trials start in the Worker (`POST /api/billing/trial`), which grants one
 * per workspace and one per account. The plugin's own trial rule is per workspace only, so it
 * would hand a person's every new workspace another trial through Checkout.
 */
function billingPlugin(env: AuthEnv, billing: BillingConfig) {
  const stripeClient = createStripeClient(billing.secretKey);
  return stripe({
    stripeClient,
    stripeWebhookSecret: billing.webhookSecret,
    // Never two paid subscriptions for one workspace. Here rather than in the subscription
    // callbacks: those are skipped when Checkout's row already exists, and their errors are
    // swallowed, while a throw here fails the webhook so Stripe retries.
    onEvent: (event) => cancelDuplicateSubscriptions(stripeClient, env.db, event, env.billingLog),
    // Customers are workspaces, created on first checkout; people never get one.
    createCustomerOnSignUp: false,
    organization: { enabled: true },
    subscription: {
      enabled: true,
      plans: [
        {
          name: PLAN_NAME,
          priceId: billing.monthlyPriceId,
          annualDiscountPriceId: billing.yearlyPriceId,
        },
      ],
      // Organization subscriptions only (the Worker refuses others): owners and admins.
      authorizeReference: ({ user, referenceId }) => mayManageBilling(env.db, user.id, referenceId),
      getCheckoutSessionParams: () => ({
        params: {
          // A promotion code box on Checkout (codes are made in Stripe, e.g. a 100%-off one for
          // friends). With nothing left to pay, no card is asked for.
          allow_promotion_codes: true,
          payment_method_collection: "if_required",
        },
      }),
    },
    // The option's type intersects the three tables' field maps and rejects any field rename;
    // this shape is what the plugin reads (and what `auth:generate` turned into our schema).
    schema: {
      subscription: { modelName: "subscriptions", fields: { referenceId: "orgId" } },
      // It adds `stripeCustomerId` to these; keep the table names the other plugins use.
      organization: { modelName: "organizations" },
      user: { modelName: "users" },
    } as unknown as StripeOptions["schema"],
  });
}

export interface AuthEnv extends Partial<
  Pick<
    AuthConfig,
    | "trustedOrigins"
    | "passkeyRpId"
    | "appName"
    | "webAppURL"
    | "google"
    | "signUp"
    | "billing"
    | "cimdHosts"
  >
> {
  db: Db;
  /** BETTER_AUTH_SECRET */
  secret: string;
  /** BETTER_AUTH_URL, the API's public origin. */
  baseURL: string;
  /** Delivers the magic link. The Worker injects the real sender. */
  sendMagicLink: MagicLinkSender;
  /** Delivers an organization invitation. The Worker injects the real sender. */
  sendInvitation: InvitationSender;
  /** Error-level log for billing a person must act on (a canceled duplicate to refund). */
  billingLog?: BillingLog;
  /**
   * Whether this instance is an OAuth authorization server for agents (ADR 0029). Default on.
   * The Worker turns it off for requests that never use it: the provider reads its resource row
   * each time an instance starts, and the Worker starts one per request.
   */
  oauthProvider?: boolean;
  /**
   * Each module's hooks for a member leaving and a workspace being deleted, in order (ADR 0035).
   * The Worker passes its `modules.ts` list; required so a caller cannot drop them by accident.
   */
  modules: readonly ModuleLifecycle[];
}

/**
 * Who gets a magic link. With open sign-up, anyone: the link proves the address, and a new
 * address becomes a user with no workspace (ADR 0018). With `invitation`, any of a known user's
 * sign-in emails (ADR 0014), or an unknown email while it holds a pending, unexpired invitation.
 */
export async function maySignIn(db: Db, email: string, policy: SignUp = "open") {
  if (policy === "open") return true;
  const address = email.toLowerCase();
  return (await findEmailOwner(db, address)) !== null || (await hasPendingInvitation(db, address));
}

/**
 * Whether `userId` may create an organization in the app under `policy`. `open`: anyone signed
 * in (a new account's first step is its own workspace). `invitation`: only someone who already
 * owns one (they set up a second workspace); everyone else joins by invitation.
 */
export async function mayCreateOrganization(db: Db, userId: string, policy: SignUp = "open") {
  if (policy === "open") return true;
  const [owned] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        eq(schema.members.role, "owner"),
        // Everyone owns their Personal space (ADR 0024); only owning a company counts.
        isCompany(db, schema.members.organizationId),
      ),
    )
    .limit(1);
  return owned !== undefined;
}

async function hasPendingInvitation(db: Db, email: string) {
  const [invitation] = await db
    .select({ id: schema.invitations.id })
    .from(schema.invitations)
    .where(
      and(
        eq(sql`lower(${schema.invitations.email})`, email.toLowerCase()),
        eq(schema.invitations.status, "pending"),
        gt(schema.invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invitation !== undefined;
}

/**
 * Better Auth instance for one request scope. The Worker calls this with its bindings, and
 * `auth.config.ts` calls it so the CLI generates `@omni/db`'s auth schema from the same options.
 * Model names are plural to match our tables.
 */
export function createAuth(env: AuthEnv) {
  return betterAuth({
    appName: env.appName ?? "Omni",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: env.trustedOrigins ?? [],
    // Any verified sign-in email finds its person, wherever Better Auth looks a user up by email.
    database: resolveSignInEmails(drizzleAdapter(env.db, { provider: "pg", schema }), env.db),
    // A new Google user goes through the same `user.create` hook as a magic link (ADR 0018).
    // `select_account` lets one browser add a second Google account (multi-session).
    socialProviders: env.google
      ? {
          google: {
            ...env.google,
            prompt: "select_account",
            // The Google address this sign-in proved, for the session's scope (ADR 0024).
            mapProfileToUser: (profile) => {
              if (profile.email_verified) noteSignInAddress(profile.email);
              return {};
            },
          },
        }
      : undefined,
    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      // Every API request reads the session; the signed cookie answers without the two queries
      // (session, user). The cost: a session revoked elsewhere (sign out a device, sign out
      // others) keeps working on that device for up to `maxAge`, so keep it short. Membership is
      // still read from the database per request, so removing a member takes effect at once.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    account: {
      modelName: "accounts",
      // One person, one user (ADR 0014): a Google sign-in joins the user who has that address,
      // but only when Google says it verified the address and our user has verified it too (a
      // magic link or an earlier Google sign-in). No provider is trusted past its own
      // `email_verified`, and an account is never linked under a different address.
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    verification: { modelName: "verifications" },
    advanced: { database: { generateId: () => uuidv7() } },
    // Browser sessions get no JWT: tokens are only for agents' OAuth grants (ADR 0029).
    disabledPaths: ["/token"],
    // Off: its default store is per-process memory (per isolate on Workers) and it keys on
    // spoofable forwarding headers. The Worker rate-limits every auth route itself.
    rateLimit: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // The one place every sign-up path (magic-link verify, Google callback) creates a user.
          // With `SIGN_UP=invitation`, a link issued while the invitation was pending stops
          // working once it is canceled.
          before: async (user) => {
            // Only a proven address becomes an identity: a magic link proves it; Google must say so.
            if (!user.emailVerified) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message: "sign-up needs a verified email",
              });
            }
            // Someone's extra sign-in email is theirs, never a new person (the adapter resolves
            // it first; this holds even if a lookup missed it).
            if (await findEmailOwner(env.db, user.email)) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_BELONGS_TO_ANOTHER_USER",
                message: "this email already signs in to an account",
              });
            }
            if (env.signUp === "invitation" && !(await hasPendingInvitation(env.db, user.email))) {
              throw new APIError("FORBIDDEN", {
                code: "SIGN_UP_REQUIRES_INVITATION",
                message: "sign-up needs a pending invitation",
              });
            }
          },
          // Every person has a Personal space from the start (ADR 0024).
          after: async (user) => {
            await ensurePersonalSpaceQuietly(env.db, user.id);
          },
        },
      },
      session: {
        create: {
          // A new session starts in the user's oldest org, the same default `requireMember`
          // uses, so Better Auth's organization endpoints and our API agree from the first call.
          // A person in no company starts in their Personal space (ADR 0024). Signing in also gives
          // a person from before ADR 0024 their Personal space.
          // A session opened with a company's address starts, and stays, in that company.
          before: async (session) => {
            await ensurePersonalSpaceQuietly(env.db, session.userId);
            const scope = await newSessionScope(env.db);
            if (scope) {
              const [inScope] = await env.db
                .select({ orgId: schema.members.organizationId })
                .from(schema.members)
                .where(
                  and(
                    eq(schema.members.userId, session.userId),
                    eq(schema.members.organizationId, scope),
                  ),
                );
              return { data: { ...session, activeOrganizationId: inScope?.orgId ?? null } };
            }
            // The oldest company first; a person in none starts in their Personal space.
            const [member] = await env.db
              .select({ orgId: schema.members.organizationId })
              .from(schema.members)
              .where(eq(schema.members.userId, session.userId))
              .orderBy(
                sql`case when ${isCompany(env.db, schema.members.organizationId)} then 0 else 1 end`,
                asc(schema.members.createdAt),
              )
              .limit(1);
            return { data: { ...session, activeOrganizationId: member?.orgId ?? null } };
          },
          after: async (session) => {
            await recordSessionScope(env.db, session.id);
          },
        },
      },
    },
    plugins: [
      // The iOS app: its requests carry `expo-origin` (native fetch sends no Origin), and a magic
      // link or Google sign-in that ends on a trusted app scheme (`omni://`, listed in
      // AUTH_TRUSTED_ORIGINS) gets the session cookie in that redirect, for the app to keep.
      expo(),
      magicLink({
        // An email that may not sign in (`SIGN_UP=invitation`) gets the same 200 and no mail, so
        // the endpoint does not reveal who has an account. Either way the Worker limits links
        // per address and per IP, so nobody can mail-bomb an inbox.
        sendMagicLink: async ({ email, url }) => {
          if (await maySignIn(env.db, email, env.signUp)) await env.sendMagicLink({ email, url });
        },
      }),
      passkey({
        rpName: env.appName ?? "Omni",
        ...(env.passkeyRpId ? { rpID: env.passkeyRpId } : {}),
        schema: { passkey: { modelName: "passkeys" } },
      }),
      organization({
        // Per SIGN_UP (ADR 0018): with open sign-up anyone signed in creates one in onboarding
        // (ADR 0007); with `invitation`, only owners. Members join by invitation either way.
        // The creator becomes its owner and it becomes their active organization.
        allowUserToCreateOrganization: (user) => mayCreateOrganization(env.db, user.id, env.signUp),
        sendInvitationEmail: ({ id, email, organization, inviter, invitation }) =>
          env.sendInvitation({
            invitationId: id,
            email,
            url: new URL(
              `/invite/${encodeURIComponent(id)}`,
              env.webAppURL ?? env.baseURL,
            ).toString(),
            organizationName: organization.name,
            inviterName: inviter.user.name || inviter.user.email,
            expiresAt: invitation.expiresAt,
          }),
        // A team is the access list of one shared mailbox (ADR 0008): `saveMailbox` creates it,
        // and `mailbox_access` is derived from its members. No default team per organization.
        teams: { enabled: true, defaultTeam: { enabled: false } },
        organizationHooks: {
          ...personalSpaceHooks(env.db),
          // The Personal space's refusal first; then each module's rows, which could otherwise
          // keep the member rows from being deleted (ADR 0035; Storage's files, ADR 0034).
          beforeDeleteOrganization: async (input) => {
            await personalSpaceHooks(env.db).beforeDeleteOrganization(input);
            await beforeDeleteWorkspace(env.db, env.modules)(input);
          },
          // What each module keeps for the company (Storage: their My files, ADR 0034).
          beforeRemoveMember: beforeRemoveMember(env.db, env.modules),
          // The invite step of onboarding, but only once the org has mailboxes: an invitation
          // sent from settings mid-setup must not skip the domain and mailbox steps.
          afterCreateInvitation: async ({ invitation }) => {
            await advanceOrgSetup(env.db, invitation.organizationId, "invites_sent", {
              onlyFrom: "mailboxes_created",
            });
          },
          // Better Auth's own team endpoints stay usable; these keep `mailbox_access` in step.
          afterAddTeamMember: ({ team }) => syncTeamMailboxAccess(env.db, team.id),
          afterRemoveTeamMember: ({ team }) => syncTeamMailboxAccess(env.db, team.id),
          // An invitation can name teams; accepting it adds the user to them without the hook above.
          // It can also carry a personal inbox, waiting with no owner; it is theirs now (ADR 0026).
          afterAcceptInvitation: async ({ invitation, member }) => {
            const teamIds = (invitation as { teamId?: string | null }).teamId?.split(",") ?? [];
            for (const teamId of teamIds) await syncTeamMailboxAccess(env.db, teamId);
            await claimInvitationInboxes(env.db, {
              orgId: invitation.organizationId,
              invitationId: invitation.id,
              memberId: member.id,
            });
            // Everyone already there hears they joined (their list shows it on its next fetch).
            await notifyMemberJoined(env.db, {
              orgId: invitation.organizationId,
              userId: member.userId,
            });
          },
          beforeDeleteTeam: async ({ team }) => {
            if (await teamMailbox(env.db, team.id)) {
              throw new APIError("BAD_REQUEST", {
                code: "TEAM_BELONGS_TO_MAILBOX",
                message: "this team is a shared mailbox's access list",
              });
            }
          },
        },
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "members" },
          invitation: { modelName: "invitations" },
          team: { modelName: "teams" },
          teamMember: { modelName: "teamMembers" },
        },
      }),
      // Several accounts signed in on one device; switch with `multiSession.setActive`.
      multiSession(),
      // Keeps the session cookie cache's active organization in step with the database.
      refreshSessionCacheOnOrgChange(),
      // Any verified sign-in email signs you in, and an invitation to one is yours (ADR 0014).
      signInEmails(env.db),
      // A session opened with a company's address stays in that company (ADR 0024).
      sessionScopeGuard(env.db),
      // A member who leaves runs each module's hooks first (ADR 0035).
      moduleLifecycle(env.db, env.modules),
      // People's own agents over MCP (ADR 0029).
      ...(env.oauthProvider === false
        ? []
        : mcpPlugins({
            db: env.db,
            baseURL: env.baseURL,
            webAppURL: env.webAppURL,
            cimdHosts: env.cimdHosts,
          })),
      ...(env.billing ? [billingPlugin(env, env.billing)] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Runs one auth request with its own sign-in store, so its session can be scoped (ADR 0024). */
export { withSignInRequest } from "./session-scope.ts";
export type { ModuleLifecycle } from "./module-lifecycle.ts";
export * from "./mcp.ts";
