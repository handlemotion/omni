import type { QueryClient } from "@tanstack/react-query";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { joinQuery } from "./join.ts";
import { needsSetup, onboardingQuery } from "./onboarding.ts";
import { isServerPath, safeRedirect, sessionQuery } from "./session.ts";

/** Signed in, member or not (the invitation page needs a user who may not have an org yet). */
export async function requireUser(client: QueryClient, location: ParsedLocation) {
  const session = await client.ensureQueryData(sessionQuery());
  if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
  return session;
}

/**
 * Signed in and a member of the active organization. Someone in no workspace yet (a new
 * account: Personal spaces are made on demand) goes to `/welcome`, or to `/join` when their
 * sign-in is scoped to a company they may ask to join. An owner or admin whose workspace's
 * setup is unfinished goes to onboarding, which resumes at the saved step; settings stay
 * reachable (to switch workspace or account, or sign out).
 */
export async function requireMember(client: QueryClient, location: ParsedLocation) {
  const session = await requireUser(client, location);
  if (!session.member) {
    const company = await client.ensureQueryData(joinQuery()).catch(() => null);
    if (company) throw redirect({ to: "/join" });
    throw redirect({ to: "/welcome" });
  }
  if (needsSetup(session.member) && !isSettings(location.pathname)) {
    throw redirect({ to: "/onboarding" });
  }
  return { ...session, member: session.member };
}

const isSettings = (pathname: string) => pathname.split("/")[2] === "settings";

/**
 * Onboarding is for someone who may create a company, or who is finishing the active one.
 * Everyone else goes to their inbox.
 */
export async function requireOnboarding(client: QueryClient) {
  const status = await client.ensureQueryData(onboardingQuery());
  if (status.canCreateOrganization || needsSetup(status.organization)) return status;
  throw redirect({ to: "/" });
}

/**
 * Sends a signed-in person away from the sign-in page: a member, and someone in no workspace yet
 * unless a native app's sign-in (`callback`) wants the form.
 */
export async function redirectIfMember(
  client: QueryClient,
  to: string | undefined,
  callback?: string,
) {
  const session = await client.ensureQueryData(sessionQuery());
  if (!session || (!session.member && callback)) return;
  const href = safeRedirect(to);
  throw redirect({ href, reloadDocument: isServerPath(href) });
}
