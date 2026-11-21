import { IconArrowRotateClockwise } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { useDesktopUpdate } from "@/hooks/use-desktop-update.ts";
import { desktop } from "@/lib/desktop.ts";

/** In the desktop app, once an update is downloaded: a blue strip that restarts into it. */
export function UpdateRow() {
  const version = useDesktopUpdate();
  if (!version) return null;
  return (
    <Button
      intent="notice"
      size="lg"
      className="w-full justify-start"
      aria-label={`Restart to update to Omni ${version}`}
      onPress={desktop.update.install}
    >
      <IconArrowRotateClockwise data-slot="icon" />
      Restart to update
      <span className="ms-auto text-primary-foreground/75 tabular-nums">{version}</span>
    </Button>
  );
}
