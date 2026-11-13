// Connecting a personal Gmail, shared by setup's inbox step and Settings, Connected accounts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  disconnectGoogleMutation,
  googleAccountsQuery,
  readGoogleOutcome,
  refreshAfterGoogle,
  startGoogleConnect,
  type GoogleOutcome,
  type GoogleReturn,
} from "../lib/google-connection.ts";

/** `{ available, accounts }`: can this install connect Google, and what you connected. */
export function useGoogleAccounts() {
  return useQuery(googleAccountsQuery());
}

/**
 * `mutate()` leaves for Google's consent screen and comes back to `from`. Stays pending until the
 * page is gone, so the button shows it is on its way.
 */
export function useConnectGoogle(from: GoogleReturn) {
  return useMutation({
    mutationFn: () => {
      startGoogleConnect(from);
      return new Promise<never>(() => {});
    },
  });
}

/** `mutate(mailboxId)` disconnects one of your Google accounts (revoked, inbox removed). */
export function useDisconnectGoogle() {
  return useMutation(disconnectGoogleMutation(useQueryClient()));
}

/**
 * Google's way back, read once from the address bar on this load: the outcome (null on any other
 * load). The `?google=` parameters are cleared and the lists refetched, so a reload doesn't
 * repeat it.
 */
export function useGoogleReturn(): GoogleOutcome | null {
  const client = useQueryClient();
  const router = useRouter();
  const [outcome] = useState(() => readGoogleOutcome(window.location.search));
  useEffect(() => {
    if (!outcome) return;
    void refreshAfterGoogle(client);
    router.history.replace(window.location.pathname);
  }, [outcome, client, router]);
  return outcome;
}
