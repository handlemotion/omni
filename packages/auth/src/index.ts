import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { stripe, type StripeOptions } from "@better-auth/stripe";
import type { Db } from "@omni/db";
import {
  advanceOrgSetup,
  findEmailOwner,
  isCompany,
  signInCodeRecipient,
  schema,
  claimInvitationInboxes,
  notifyMemberJoined,
  syncTeamMailboxAccess,
  teamMailbox,
} from "@omni/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import {
  hasPendingInvitation,
  mayCreateOrganization,
  mayManageBilling,
  maySignIn,
} from "./access.ts";
import type { AuthConfig, BillingConfig } from "./env.ts";
import { type BillingLog, cancelDuplicateSubscriptions } from "./one-subscription.ts";
import { planCapHooks } from "./plan-caps.ts";
import { resolveSignInEmails, signInEmails } from "./sign-in-emails.ts";
import {
  afterUpdateMemberRole,
  beforeDeleteWorkspace,
  beforeRemoveMember,
  moduleLifecycle,
  type ModuleLifecycle,
} from "./module-lifecycle.ts";
import { ensureGranteeSpaceQuietly } from "./personal-space.ts";
import { mcpPlugins } from "./mcp.ts";
import {
  endScopedSessions,
  newSessionScope,
  noteSignInAddress,
  recordSessionScope,
  sessionScopeGuard,
} from "./session-scope.ts";
import { refreshSessionCacheOnOrgChange } from "./session-cache.ts";
import { emailOTP } from "better-auth/plugins/email-otp";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import { adminAc, defaultAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { and, asc, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { uuidv7 } from "uuidv7";

export {
  authEnvSchema,
  authForOrigin,
  parseAuthEnv,
  type AuthConfig,
  type BillingConfig,
  type SignUp,
} from "./env.ts";
export { mayCreateOrganization, mayManageBilling, maySignIn } from "./access.ts";

/** `email`: where the sign-in code is mailed. `signInAs`: the address it signs in. */
export type EmailOtpSender = (message: {
  email: string;
  signInAs: string;
  otp: string;
}) => Promise<void>;

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

export { planOfPrice, planPriceIds, type PlanPrices } from "./billing-env.ts";

/** A Stripe client that works on Workers (fetch, Web Crypto) and in Node. */
export function createStripeClient(secretKey: string) {
  return new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

function billingPlugin(db: Db, billing: BillingConfig, billingLog?: BillingLog) {
  const stripeClient = createStripeClient(billing.secretKey);
  return stripe({
    stripeClient,
    stripeWebhookSecret: billing.webhookSecret,
    onEvent: (event) => cancelDuplicateSubscriptions(stripeClient, db, event, billingLog),
    createCustomerOnSignUp: false,
    organization: { enabled: true },
    subscription: {
      enabled: true,
      plans: Object.entries(billing.plans).map(([name, prices]) => ({
        name,
        priceId: prices.monthlyPriceId,
        annualDiscountPriceId: prices.yearlyPriceId,
      })),
      authorizeReference: ({ user, referenceId }) => mayManageBilling(db, user.id, referenceId),
      getCheckoutSessionParams: () => ({
        params: {
          allow_promotion_codes: true,
          payment_method_collection: "if_required",
        },
      }),
    },
    schema: {
      subscription: { modelName: "subscriptions", fields: { referenceId: "orgId" } },
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
    | "apple"
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
  /** Delivers the 6-digit sign-in code. The Worker injects the real sender. */
  sendEmailOtp: EmailOtpSender;
  /** Delivers an organization invitation. The Worker injects the real sender. */
  sendInvitation: InvitationSender;
  /** Error-level log for billing a person must act on (a canceled duplicate to refund). */
  billingLog?: BillingLog;
  /**
   * Whether this instance is an OAuth authorization server for agents. Default on.
   * The Worker turns it off for requests that never use it: the provider reads its resource row
   * each time an instance starts, and the Worker starts one per request.
   */
  oauthProvider?: boolean;
  /**
   * Each module's hooks for a member leaving and a workspace being deleted, in order.
   * The Worker passes its `modules.ts` list; required so a caller cannot drop them by accident.
   */
  modules: readonly ModuleLifecycle[];
}

const freelancerAc = defaultAc.newRole({ ...memberAc.statements });

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
    trustedOrigins: [
      ...(env.trustedOrigins ?? []),
      ...(env.apple ? ["https://appleid.apple.com"] : []),
    ],
    database: resolveSignInEmails(drizzleAdapter(env.db, { provider: "pg", schema }), env.db),
    socialProviders:
      env.google || env.apple
        ? {
            ...(env.google
              ? {
                  google: {
                    ...env.google,
                    prompt: "select_account",
                    mapProfileToUser: (profile: { email?: string; email_verified?: boolean }) => {
                      if (profile.email_verified && profile.email) noteSignInAddress(profile.email);
                      return {};
                    },
                  },
                }
              : {}),
            ...(env.apple
              ? {
                  apple: {
                    ...env.apple,
                    mapProfileToUser: (profile: {
                      email?: string;
                      email_verified?: boolean | string;
                    }) => {
                      const verified =
                        profile.email_verified === true || profile.email_verified === "true";
                      if (verified && profile.email) noteSignInAddress(profile.email);
                      return {};
                    },
                  },
                }
              : {}),
          }
        : undefined,
    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      cookieCache: { enabled: true, maxAge: 60 },
    },
    account: {
      modelName: "accounts",
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    verification: { modelName: "verifications" },
    advanced: { database: { generateId: () => uuidv7() } },
    disabledPaths: ["/token"],
    rateLimit: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!user.emailVerified) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message: "sign-up needs a verified email",
              });
            }
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
        },
      },
      session: {
        create: {
          before: async (session) => {
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
            await ensureGranteeSpaceQuietly(env.db, session.userId);
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
      expo(),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp, type }, ctx) => {
          if (type !== "sign-in") return;
          const bodyEmail = (ctx?.body as { email?: unknown } | undefined)?.email;
          const signInAs = typeof bodyEmail === "string" && bodyEmail ? bodyEmail : email;
          if (!(await maySignIn(env.db, signInAs, env.signUp))) return;
          const to = await signInCodeRecipient(env.db, signInAs);
          await env.sendEmailOtp({ email: to, signInAs, otp });
        },
      }),
      passkey({
        rpName: env.appName ?? "Omni",
        ...(env.passkeyRpId ? { rpID: env.passkeyRpId } : {}),
        schema: { passkey: { modelName: "passkeys" } },
      }),
      organization({
        allowUserToCreateOrganization: (user) => mayCreateOrganization(env.db, user.id, env.signUp),
        requireEmailVerificationOnInvitation: true,
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
        teams: { enabled: true, defaultTeam: { enabled: false } },
        roles: { owner: ownerAc, admin: adminAc, member: memberAc, freelancer: freelancerAc },
        organizationHooks: {
          ...(env.billing && planCapHooks(env.db)),
          beforeDeleteOrganization: async (input) => {
            await endScopedSessions(env.db, input.organization.id);
            await beforeDeleteWorkspace(env.db, env.modules)(input);
          },
          beforeRemoveMember: beforeRemoveMember(env.db, env.modules),
          afterUpdateMemberRole: afterUpdateMemberRole(env.db, env.modules),
          afterCreateInvitation: async ({ invitation }) => {
            await advanceOrgSetup(env.db, invitation.organizationId, "invites_sent", {
              onlyFrom: "mailboxes_created",
            });
          },
          afterAddTeamMember: ({ team }) => syncTeamMailboxAccess(env.db, team.id),
          afterRemoveTeamMember: ({ team }) => syncTeamMailboxAccess(env.db, team.id),
          afterAcceptInvitation: async ({ invitation, member }) => {
            const teamIds = (invitation as { teamId?: string | null }).teamId?.split(",") ?? [];
            for (const teamId of teamIds) await syncTeamMailboxAccess(env.db, teamId);
            await claimInvitationInboxes(env.db, {
              orgId: invitation.organizationId,
              invitationId: invitation.id,
              memberId: member.id,
            });
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
      multiSession(),
      refreshSessionCacheOnOrgChange(),
      signInEmails(env.db),
      sessionScopeGuard(env.db),
      moduleLifecycle(env.db, env.modules),
      ...(env.oauthProvider === false
        ? []
        : mcpPlugins({
            db: env.db,
            baseURL: env.baseURL,
            webAppURL: env.webAppURL,
            cimdHosts: env.cimdHosts,
          })),
      ...(env.billing ? [billingPlugin(env.db, env.billing, env.billingLog)] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Runs one auth request with its own sign-in store, so its session can be scoped. */
export { withSignInRequest } from "./session-scope.ts";
export type { ModuleLifecycle } from "./module-lifecycle.ts";
export * from "./mcp.ts";
