import { IconArrowRotateClockwise } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useDesktopUpdate } from "@/hooks/use-desktop-update.ts";
import { desktop } from "@/lib/desktop.ts";

/**
 * In the desktop app, once an update is downloaded: a blue strip, a nav row's height, that
 * restarts into it.
 */
export function UpdateRow() {
  const version = useDesktopUpdate();
  if (!version) return null;
  return (
    <Button
      intent="notice"
      size="md"
      className="w-full justify-start px-2"
      aria-label={`Restart to update to Omni ${version}`}
      onPress={desktop.update.install}
    >
      <IconArrowRotateClockwise data-slot="icon" />
      Restart to update
      <span className="ms-auto text-primary-foreground/75 tabular-nums">{version}</span>
    </Button>
  );
}

/** The rail's mark for a downloaded update while the sidebar (and its strip) is closed. */
export function UpdateTile({ className }: { className: string }) {
  const version = useDesktopUpdate();
  if (!version) return null;
  return (
    <TooltipTrigger>
      <Button
        intent="notice"
        aria-label={`Restart to update to Omni ${version}`}
        className={className}
        onPress={desktop.update.install}
      >
        <IconArrowRotateClockwise data-slot="icon" />
      </Button>
      <Tooltip placement="right">Restart to update</Tooltip>
    </TooltipTrigger>
  );
}
