// Route guards, called from `beforeLoad`. They read the session through the query cache, so
// navigating between signed-in routes costs no request.
import type { QueryClient } from "@tanstack/react-query";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { mailboxesQuery } from "./mail-queries.ts";
import { needsSetup, onboardingQuery } from "./onboarding.ts";
import { safeRedirect, sessionQuery } from "./session.ts";

/** Signed in, member or not (the invitation page needs a user who may not have an org yet). */
export async function requireUser(client: QueryClient, location: ParsedLocation) {
  const session = await client.ensureQueryData(sessionQuery());
  if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
  return session;
}

/**
 * Signed in and a member of the active organization. A user with no organization goes to
 * onboarding when this deployment lets them create one (ORGANIZATION_CREATION), otherwise back
 * to sign-in with `no_organization` (they need an invitation). An owner or admin whose
 * workspace has no mailboxes yet goes to onboarding to finish it.
 */
export async function requireMember(client: QueryClient, location: ParsedLocation) {
  const session = await requireUser(client, location);
  if (!session.member) {
    const status = await client.ensureQueryData(onboardingQuery());
    if (status.canCreateOrganization) throw redirect({ to: "/onboarding" });
    throw redirect({ to: "/login", search: { error: "no_organization" } });
  }
  const { role } = session.member;
  if (role === "owner" || role === "admin") {
    // Mailboxes are cached for the shell anyway; only an empty list costs the status request.
    const mailboxes = await client.ensureQueryData(mailboxesQuery());
    if (
      mailboxes.mailboxes.length === 0 &&
      needsSetup(await client.ensureQueryData(onboardingQuery()))
    ) {
      throw redirect({ to: "/onboarding" });
    }
  }
  return { ...session, member: session.member };
}

/**
 * Onboarding is for someone who may create a workspace, or who is finishing the active one.
 * Everyone else goes where they belong.
 */
export async function requireOnboarding(client: QueryClient) {
  const status = await client.ensureQueryData(onboardingQuery());
  if (status.canCreateOrganization || needsSetup(status)) return status;
  if (status.organization) throw redirect({ to: "/inbox" });
  throw redirect({ to: "/login", search: { error: "no_organization" } });
}

/** Sends a signed-in member away from the sign-in page. */
export async function redirectIfMember(client: QueryClient, to: string | undefined) {
  const session = await client.ensureQueryData(sessionQuery());
  if (session?.member) throw redirect({ href: safeRedirect(to) });
}
