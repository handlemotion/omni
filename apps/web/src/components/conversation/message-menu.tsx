import type { ReactNode } from "react";
import { IconEllipsis, IconForward, IconReply } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { quoteText } from "@/lib/reply.ts";
import { menuButtonClass } from "../chat/chat-message.tsx";
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
  /** Reply and Forward are buttons in the message's header, so the menu leaves them out. */
  inline?: boolean;
  /** On a message's action island, which shows and hides it: always drawn, 20px and muted. */
  island?: boolean;
}) {
  const composer = useComposerState();
  const messageId = props.inline ? undefined : props.messageId;
  const canReply = composer.chat && props.text.trim().length > 0;
  const canMail = !props.inline && (!composer.chat || !!messageId);
  if (!canReply && !canMail && !props.extra) return null;
  return (
    <MenuTrigger>
      <Button
        intent="ghost"
        // Beside Reply and Forward (a single email), their size; in a chat line, a small one.
        size={props.visible ? "sq-xs" : "sq-2xs"}
        aria-label={props.label}
        className={menuButtonClass(props)}
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
        {/* Email reply: always on a personal thread; on a shared inbox, from a mail message,
            which also reopens a composer a discard closed. To everyone there, as it defaults. */}
        {canMail && (
          <MenuItem
            textValue="Reply"
            onAction={() =>
              composer.openReply(composer.chat ? "replyAll" : "reply", props.messageId)
            }
          >
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
