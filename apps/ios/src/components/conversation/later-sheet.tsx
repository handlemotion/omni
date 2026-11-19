import { IconCalendar, IconClock, IconSunrise } from "@/components/icons.ts";
import { MenuRow } from "@/components/shell/menu-row.tsx";
import { BottomSheet } from "@/components/ui/bottom-sheet.tsx";
import { snoozePresets } from "@/lib/thread-actions.ts";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const ICONS = { later: IconClock, tomorrow: IconSunrise, week: IconCalendar } as const;

function whenOf(until: Date, now: Date) {
  return until.toDateString() === now.toDateString() ? TIME.format(until) : DAY_TIME.format(until);
}

/**
 * Later's choices, each with the time it brings the thread back: Later today, Tomorrow and Next
 * week. `onPick` gets the chosen time once the sheet starts closing.
 */
export function LaterSheet(props: {
  isOpen: boolean;
  onClose: () => void;
  onPick: (until: Date) => void;
}) {
  const now = new Date();
  return (
    <BottomSheet isOpen={props.isOpen} onClose={props.onClose} title="Later">
      {snoozePresets(now).map((preset) => (
        <MenuRow
          key={preset.id}
          icon={ICONS[preset.id as keyof typeof ICONS]}
          muted
          label={preset.label}
          detail={whenOf(preset.until, now)}
          onPress={() => {
            props.onClose();
            props.onPick(preset.until);
          }}
        />
      ))}
    </BottomSheet>
  );
}
