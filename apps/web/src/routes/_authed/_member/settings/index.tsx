// `/settings` is a way into the settings dialog, which opens over the workspace from anywhere
// (⌘.). Kept as a path so links and the onboarding guard's exemption (ADR 0009) still work;
// closing the dialog here returns to the inbox.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { openSettings } from "../../../../hooks/use-settings-dialog.ts";

export const Route = createFileRoute("/_authed/_member/settings/")({
  component: OpenSettings,
});

function OpenSettings() {
  useEffect(() => openSettings(), []);
  return null;
}
