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
