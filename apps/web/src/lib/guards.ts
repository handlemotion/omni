// Route guards, called from `beforeLoad`. They read the session through the query cache, so
// navigating between signed-in routes costs no request.
import type { QueryClient } from "@tanstack/react-query";
import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { safeRedirect, sessionQuery } from "./session.ts";

/** Signed in, member or not (the invitation page needs a user who may not have an org yet). */
export async function requireUser(client: QueryClient, location: ParsedLocation) {
  const session = await client.ensureQueryData(sessionQuery());
  if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
  return session;
}

/** Signed in and a member of the active organization. */
export async function requireMember(client: QueryClient, location: ParsedLocation) {
  const session = await requireUser(client, location);
  if (!session.member) throw redirect({ to: "/login", search: { error: "no_organization" } });
  return { ...session, member: session.member };
}

/** Sends a signed-in member away from the sign-in page. */
export async function redirectIfMember(client: QueryClient, to: string | undefined) {
  const session = await client.ensureQueryData(sessionQuery());
  if (session?.member) throw redirect({ href: safeRedirect(to) });
}
