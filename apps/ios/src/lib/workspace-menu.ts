import type { Workspace } from "@omni/client";
import { useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { api, call } from "./api.ts";
import { config } from "./config.ts";
import { keys } from "./query-keys.ts";

const isManager = (role: string) => /\b(owner|admin)\b/.test(role);

/**
 * What the workspace sheet offers beyond the workspaces, as the desktop's workspace menu decides
 * it: New workspace when you may start one; Invite members to a company's managers; Upgrade to
 * those who manage its plan while it is on a trial, unpaid or read-only.
 */
export function useWorkspaceMenu(active: Workspace | undefined) {
  const team = !!active && active.kind !== "personal" && isManager(active.role);
  const onboarding = useQuery({
    queryKey: keys.onboarding(),
    queryFn: ({ signal }) => call(api.onboarding.$get(undefined, { init: { signal } })),
    staleTime: 5 * 60_000,
    enabled: !!active,
  });
  const billing = useQuery({
    queryKey: keys.billing(),
    queryFn: ({ signal }) => call(api.billing.$get(undefined, { init: { signal } })),
    staleTime: 5 * 60_000,
    enabled: team,
  });
  const plan = billing.data?.enabled ? billing.data : null;
  const upgrade =
    team &&
    !!plan?.canManage &&
    (plan.readOnly || !plan.subscription || plan.subscription.status === "trialing");
  return { canCreate: onboarding.data?.canCreateOrganization === true, team, upgrade };
}

/** The web app's settings pages the phone has no screen for. */
export type WebSettingsPage = "general" | "accounts" | "people" | "billing";

/**
 * Opens a page of the web app (served where the API is) in an in-app browser: a workspace's
 * settings page, or `/onboarding` to start a workspace.
 */
export function openOnWeb(
  path: { settings: WebSettingsPage; workspace: Workspace } | "onboarding",
) {
  const at =
    path === "onboarding"
      ? "/onboarding"
      : `/${encodeURIComponent(path.workspace.slug)}/settings/${path.settings}`;
  void WebBrowser.openBrowserAsync(new URL(at, config.apiUrl).toString());
}
