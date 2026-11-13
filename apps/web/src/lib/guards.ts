// Route guards, called from `beforeLoad`. They read the session through the query cache, so
// navigating between signed-in routes costs no request.
import type { QueryClient } from "@tanstack/react-query";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { joinQuery } from "./join.ts";
import { needsSetup, onboardingQuery } from "./onboarding.ts";
import { safeRedirect, sessionQuery } from "./session.ts";

/** Signed in, member or not (the invitation page needs a user who may not have an org yet). */
export async function requireUser(client: QueryClient, location: ParsedLocation) {
  const session = await client.ensureQueryData(sessionQuery());
  if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
  return session;
}

/**
 * Signed in and a member of the active organization: everyone is, at least of their Personal
 * space (ADR 0024). An owner or admin whose workspace's setup is unfinished goes to onboarding,
 * which resumes at the saved step; settings stay reachable (to switch workspace or account, or
 * sign out).
 */
export async function requireMember(client: QueryClient, location: ParsedLocation) {
  const session = await requireUser(client, location);
  // No member: a sign-in with a company's address whose person is not its member asks to join
  // it (ADR 0024); anything else signs in again.
  if (!session.member) {
    const company = await client.ensureQueryData(joinQuery()).catch(() => null);
    if (company) throw redirect({ to: "/join" });
    throw redirect({ to: "/login", search: { redirect: location.href } });
  }
  if (needsSetup(session.member) && !isSettings(location.pathname)) {
    throw redirect({ to: "/onboarding" });
  }
  return { ...session, member: session.member };
}

const isSettings = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

/**
 * Onboarding is for someone who may create a company, or who is finishing the active one.
 * Everyone else goes to their inbox.
 */
export async function requireOnboarding(client: QueryClient) {
  const status = await client.ensureQueryData(onboardingQuery());
  if (status.canCreateOrganization || needsSetup(status.organization)) return status;
  throw redirect({ to: "/inbox" });
}

/** Sends a signed-in member away from the sign-in page. */
export async function redirectIfMember(client: QueryClient, to: string | undefined) {
  const session = await client.ensureQueryData(sessionQuery());
  if (session?.member) throw redirect({ href: safeRedirect(to) });
}
