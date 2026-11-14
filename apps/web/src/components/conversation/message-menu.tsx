import type { ReactNode } from "react";
import { IconEllipsis, IconForward, IconReply } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { quoteText } from "@/lib/reply.ts";
import { useComposerState } from "../compose/composer-state.tsx";

/**
 * The ⋯ beside a message or note in the timeline: reply to it in a hidden note (shared inboxes) or
 * by email (personal threads, which open the composer), forward
 * it (mail only), and whatever the item adds (edit and delete on your own notes). It shows on
 * hover or focus, like a chat app's message actions; touch screens always show it.
 */
export function MessageMenu(props: {
  label: string;
  /** Who wrote it, for the reply's quote. */
  from: string;
  text: string;
  /** Set for mail: it can be forwarded. */
  messageId?: string;
  extra?: ReactNode;
  /**
   * On a right-aligned item (yours, notes): first in its header, so the time keeps the right
   * edge in line with the bubble instead of leaving room for a button that only shows on hover.
   */
  start?: boolean;
  /** Always shown, not only on hover: a header with its other actions in view (a single email). */
  visible?: boolean;
}) {
  const composer = useComposerState();
  const { messageId } = props;
  const canReply = composer.chat && props.text.trim().length > 0;
  if (!canReply && composer.chat && !props.messageId && !props.extra) return null;
  return (
    <MenuTrigger>
      <Button
        intent="ghost"
        // Beside Reply and Forward (a single email), their size; in a chat line, a small one.
        size={props.visible ? "sq-xs" : "sq-2xs"}
        aria-label={props.label}
        className={`${props.visible ? "text-muted-foreground hover:text-foreground" : "-my-0.5"} ${props.start ? "order-first" : ""} ${props.visible ? "" : "opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"}`}
      >
        <IconEllipsis />
      </Button>
      <Menu placement="bottom end">
        {canReply && (
          <MenuItem
            textValue="Hidden reply"
            onAction={() => composer.replyInChat({ from: props.from, text: quoteText(props.text) })}
          >
            <IconReply data-slot="icon" />
            <MenuLabel>Hidden reply</MenuLabel>
          </MenuItem>
        )}
        {!composer.chat && (
          <MenuItem textValue="Reply" onAction={() => composer.openReply("reply")}>
            <IconReply data-slot="icon" />
            <MenuLabel>Reply</MenuLabel>
          </MenuItem>
        )}
        {messageId && (
          <MenuItem textValue="Forward" onAction={() => composer.forward(messageId)}>
            <IconForward data-slot="icon" />
            <MenuLabel>Forward</MenuLabel>
          </MenuItem>
        )}
        {props.extra}
      </Menu>
    </MenuTrigger>
  );
}
