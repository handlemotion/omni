// `/settings` opens settings on the page it showed last. Kept as a path for links (the Worker's
// join redirect) and the onboarding guard's exemption (ADR 0009).
import { createFileRoute, redirect } from "@tanstack/react-router";
import { lastSettingsPage } from "../../../../hooks/use-settings.ts";

export const Route = createFileRoute("/_authed/$workspace/settings/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$workspace/settings/$page",
      params: { workspace: params.workspace, page: lastSettingsPage() },
      replace: true,
    });
  },
});
