import type { ReactNode } from "react";
import { IconSend } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The composer's bottom row: its own tools at the start, Send (Cmd/Ctrl+Enter) at the end. */
export function Toolbar(props: {
  start: ReactNode;
  canSend: boolean;
  isPending: boolean;
  onSend: () => void;
  /** The send button's label: Send, or Add note. */
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1">{props.start}</div>
      <TooltipTrigger delay={400}>
        <Button
          size="sm"
          isDisabled={!props.canSend}
          isPending={props.isPending}
          onPress={props.onSend}
          aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
        >
          <IconSend />
          {props.label ?? "Send"}
        </Button>
        <Tooltip>{`${props.label ?? "Send"} ${isMac ? "⌘↵" : "Ctrl+Enter"}`}</Tooltip>
      </TooltipTrigger>
    </div>
  );
}
