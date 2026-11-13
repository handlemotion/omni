// `/settings/accounts` opens the settings dialog on Connected accounts. It is where Google sends
// people back after connecting a Gmail from Settings (the Worker's `/api/connect/google/callback`),
// with `?google=connected|error`. Closing the dialog here returns to the inbox.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { openSettings } from "../../../../hooks/use-settings-dialog.ts";
import { googleAccountsQuery } from "../../../../lib/google-connection.ts";

export const Route = createFileRoute("/_authed/_member/settings/accounts")({
  loader: ({ context }) => context.queryClient.ensureQueryData(googleAccountsQuery()),
  component: OpenAccounts,
});

function OpenAccounts() {
  useEffect(() => openSettings("accounts"), []);
  return null;
}
