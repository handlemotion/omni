// One settings page, in the app shell beside the settings nav. `/settings/billing` is where Stripe
// sends people back (Checkout and the customer portal) and `/settings/accounts` where Google does
// after connecting a Gmail (`?google=connected|error`): their loaders have the data ready, so the
// page shows it as it is now. An unknown page opens the one shown last.
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
