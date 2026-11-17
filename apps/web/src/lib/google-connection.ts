// Connecting a personal Gmail (ADR 0023). The Worker runs OAuth: a top-level navigation to its
// `/api/connect/google/start` leaves for Google's consent screen, and Google comes back through
// the Worker to the page that started it with `?google=connected|error&reason=…`.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import { desktop } from "./desktop.ts";
import { keys } from "./query-keys.ts";

/** `{ available, accounts: [{ mailboxId, address, status }] }`. */
export const googleAccountsQuery = () =>
  queryOptions({
    queryKey: keys.googleAccounts(),
    queryFn: ({ signal }) => call(api.connect.google.$get(undefined, { init: { signal } })),
  });

/** Where Google sends the browser back to: setup's inbox step, or Settings (the default). */
export type GoogleReturn = "onboarding" | "settings";

/**
 * Leaves for Google's consent screen. Nothing after this runs: the page is gone. In the desktop
 * app the consent opens in the person's browser instead (Google refuses embedded sign-in), and
 * the Worker sends Google's return back to this window through the shell's `omni://open`.
 */
export async function startGoogleConnect(from: GoogleReturn) {
  const url = new URL("/api/connect/google/start", window.location.origin);
  // The account goes where its address belongs (ADR 0024): the company that claimed its domain,
  // or the Personal space. Setup claims the company's domain before it connects anyone.
  if (from === "onboarding") url.searchParams.set("return", "onboarding");
  // Today's Worker places every account by address; a Worker from before that does so only with
  // this flag. Kept until no such Worker can serve this page.
  url.searchParams.set("place", "address");
  if (!desktop.isDesktop) {
    window.location.assign(url.toString());
    return;
  }
  url.searchParams.set("desktop", "1");
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new ApiError(response.status, "could not start Google");
  const { url: consent } = (await response.json()) as { url: string };
  desktop.openOutside(consent);
}

/** The outcome Google's return put in the address bar, if this load is one. */
export type GoogleOutcome =
  | { kind: "connected"; mailboxId: string | null }
  | { kind: "error"; reason: string };

export const readGoogleOutcome: (search: string) => GoogleOutcome | null = (search) => {
  const params = new URLSearchParams(search);
  const google = params.get("google");
  if (google === "connected") return { kind: "connected", mailboxId: params.get("mailboxId") };
  if (google === "error") return { kind: "error", reason: params.get("reason") ?? "failed" };
  return null;
};

/** What went wrong, in words, for each reason the Worker returns. */
export function googleErrorText(reason: string) {
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
    meta: { handlesError: true },
    mutationFn: (mailboxId: string) =>
      call(api.connect.google[":mailboxId"].$delete({ param: { mailboxId } })),
    onSettled: () => refreshAfterGoogle(client),
  });
