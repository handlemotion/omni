// Connecting a personal Gmail (ADR 0023). The Worker runs OAuth: a top-level navigation to its
// `/api/connect/google/start` leaves for Google's consent screen, and Google comes back through
// the Worker to the page that started it with `?google=connected|error&reason=…`.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/** `{ available, accounts: [{ mailboxId, address, status }] }`. */
export const googleAccountsQuery = () =>
  queryOptions({
    queryKey: keys.googleAccounts(),
    queryFn: ({ signal }) => call(api.connect.google.$get(undefined, { init: { signal } })),
  });

/** Where Google sends the browser back to: setup's inbox step, or Settings (the default). */
export type GoogleReturn = "onboarding" | "settings";

/** Leaves for Google's consent screen. Nothing after this runs: the page is gone. */
export function startGoogleConnect(from: GoogleReturn) {
  const url = new URL("/api/connect/google/start", window.location.origin);
  if (from === "onboarding") url.searchParams.set("return", "onboarding");
  // From Settings the account goes where its address belongs (ADR 0024): the company that claimed
  // its domain, or the Personal space. Setup's inbox step still connects into the company it sets
  // up until that step is redesigned.
  else url.searchParams.set("place", "address");
  window.location.assign(url.toString());
}

/** The outcome Google's return put in the address bar, if this load is one. */
export type GoogleOutcome =
  | { kind: "connected"; mailboxId: string | null }
  | { kind: "error"; reason: string };

export function readGoogleOutcome(search: string): GoogleOutcome | null {
  const params = new URLSearchParams(search);
  const google = params.get("google");
  if (google === "connected") return { kind: "connected", mailboxId: params.get("mailboxId") };
  if (google === "error") return { kind: "error", reason: params.get("reason") ?? "failed" };
  return null;
}

/** What went wrong, in words, for each reason the Worker returns. */
export function googleErrorText(reason: string): string {
  switch (reason) {
    case "denied":
      return "Google wasn't given access. Try again and allow Omni to read and send mail.";
    case "in_use":
      return "That Google account is already connected to another workspace, or its address belongs to a workspace you're not in.";
    case "expired":
      return "The sign-in took too long or was opened in another browser. Try again.";
    default:
      return "Google didn't connect. Try again in a moment.";
  }
}

/**
 * Refetches what connecting or disconnecting changed: every mail query (a disconnected inbox's
 * threads, counts and search results are gone, and nothing says so over realtime), setup and the
 * switcher.
 */
export const refreshAfterGoogle = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.mail() }),
    client.invalidateQueries({ queryKey: keys.onboarding() }),
    client.invalidateQueries({ queryKey: keys.workspaces() }),
  ]);

/** `mutate(mailboxId)`: revoked at Google, no longer synced, the inbox removed. */
export const disconnectGoogleMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (mailboxId: string) =>
      call(api.connect.google[":mailboxId"].$delete({ param: { mailboxId } })),
    onSettled: () => refreshAfterGoogle(client),
  });
