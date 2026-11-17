import { createFileRoute, redirect } from "@tanstack/react-router";
import { SettingsPage } from "../../../../components/settings/settings-page.tsx";
import {
  isSettingsPage,
  lastSettingsPage,
  rememberSettingsPage,
} from "../../../../hooks/use-settings.ts";
import { billingQuery } from "../../../../lib/billing.ts";
import { googleAccountsQuery } from "../../../../lib/google-connection.ts";

export const Route = createFileRoute("/_authed/$workspace/settings/$page")({
  beforeLoad: ({ params }) => {
    if (!isSettingsPage(params.page)) {
      throw redirect({
        to: "/$workspace/settings/$page",
        params: { workspace: params.workspace, page: lastSettingsPage() },
        replace: true,
      });
    }
    rememberSettingsPage(params.page);
  },
  loader: ({ context, params }) => {
    if (params.page === "billing") return context.queryClient.ensureQueryData(billingQuery());
    if (params.page === "accounts")
      return context.queryClient.ensureQueryData(googleAccountsQuery());
  },
  component: Page,
});

function Page() {
  const { page } = Route.useParams();
  return isSettingsPage(page) ? <SettingsPage page={page} /> : null;
}
