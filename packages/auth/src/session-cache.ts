import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { setCookieCache } from "better-auth/cookies";

/**
 * The session cookie cache (`session.cookieCache`) holds the session's `activeOrganizationId`,
 * and the API trusts it to pick the member. Better Auth renews the cache on `set-active`, but
 * creating, deleting or leaving an organization, accepting an invitation or removing yourself
 * change the active organization in the database only, so the old one would answer until the
 * cache expires: a new workspace would open as the previous one. After any organization call,
 * when the stored active organization moved, the cache is rewritten from the database.
 */
export function refreshSessionCacheOnOrgChange() {
  return {
    id: "omni-session-cache",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path?.startsWith("/organization/") === true,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request?.method !== "POST") return;
            const cacheName = ctx.context.authCookies.sessionData.name;
            const renewing = ctx.context.responseHeaders
              ?.getSetCookie()
              .some(
                (cookie) =>
                  cookie.startsWith(`${cacheName}=`) || cookie.startsWith(`${cacheName}.`),
              );
            if (renewing) return;
            const before = ctx.context.session ?? (await getSessionFromCtx(ctx));
            if (!before) return;
            const fresh = await ctx.context.internalAdapter.findSession(before.session.token);
            if (!fresh) return;
            const active = (s: object) =>
              (s as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
            if (active(fresh.session) === active(before.session)) return;
            const dontRememberMe = await ctx.getSignedCookie(
              ctx.context.authCookies.dontRememberToken.name,
              ctx.context.secret,
            );
            await setCookieCache(ctx, fresh, Boolean(dontRememberMe));
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
