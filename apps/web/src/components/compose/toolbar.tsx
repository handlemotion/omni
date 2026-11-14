import type { ReactNode } from "react";
import { IconSend } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The composer's bottom row: its own tools at the start, Send (Cmd/Ctrl+Enter) at the end. */
export function Toolbar(props: {
  start: ReactNode;
  /** Before Send (a reply's Discard). */
  end?: ReactNode;
  canSend: boolean;
  isPending: boolean;
  onSend: () => void;
  /** The send button's label: Send, or Add note. */
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-3">
      <div className="flex items-center gap-1">{props.start}</div>
      {/* 12px between Discard and Send: a destructive tool kept apart from the main action. */}
      <div className="flex items-center gap-3">
        {props.end}
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
    </div>
  );
}
