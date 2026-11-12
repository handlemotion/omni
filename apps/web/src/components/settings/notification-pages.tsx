// Notifications: whether this device shows your helpdesk notifications (assigned to you,
// mentioned, a customer replied, due soon, overdue) as system notifications while Omni is in the
// background. Per device: the browser's permission is per device too.
import { useState } from "react";
import { appToast } from "@/components/ui/toast";
import {
  setDesktopNotifications,
  useDesktopNotificationState,
} from "@/hooks/use-desktop-notifications.ts";
import { SettingsGroup, SettingsSection, SettingsSections } from "./kit/settings-layout";
import { SettingsToggleRow } from "./kit/settings-toggle-row";

const DESCRIPTIONS = {
  unsupported: "This browser can't show notifications.",
  blocked: "Blocked for Omni in this browser's site settings.",
  on: "When you're assigned, mentioned, a customer replies, or a conversation is due.",
  off: "When you're assigned, mentioned, a customer replies, or a conversation is due.",
} as const;

export function NotificationsPage() {
  const state = useDesktopNotificationState();
  const [asking, setAsking] = useState(false);
  return (
    <SettingsSections>
      <SettingsSection
        title="This device"
        info="Shown while Omni is in the background. Other devices keep their own choice."
      >
        <SettingsGroup>
          <SettingsToggleRow
            id="desktop-notifications"
            label="Desktop notifications"
            description={DESCRIPTIONS[state]}
            checked={state === "on"}
            disabled={asking || state === "unsupported" || state === "blocked"}
            onCheckedChange={async (on) => {
              setAsking(true);
              const next = await setDesktopNotifications(on);
              setAsking(false);
              if (on && next === "blocked") appToast.error("The browser blocked notifications.");
            }}
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsSections>
  );
}
