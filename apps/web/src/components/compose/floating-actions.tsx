import { verificationCode } from "@omni/mail-core/verification-code";
import { type ReactNode, type Ref, useMemo, useRef } from "react";
import {
  IconCheck,
  IconCopy,
  IconForward,
  IconPencil,
  IconReply,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useClipboard } from "@/hooks/use-clipboard";
import type { Thread } from "@/lib/types.ts";
import { useComposerState } from "./composer-state.tsx";

const FLOAT = "shadow-(--shadow-overlay)";

/**
 * Reply and Forward for the open thread, at the reading pane's bottom right. Gone while a
 * composer is docked there (an email, or a shared conversation's hidden notes).
 *
 * On a sign-in or verification email the main action is Copy code instead: nobody answers
 * those. Reply and Forward move into a Respond menu beside it.
 */
export function FloatingReply({ thread, messageId }: { thread: Thread; messageId?: string }) {
  const composer = useComposerState();
  const latest = thread.messages.find((m) => m.id === messageId) ?? thread.messages.at(-1);
  const composing = composer.chatOpen || (composer.email && composer.mode === "public");
  const pair = useRef<HTMLDivElement>(null);
  const pairBox = useMemo(
    () => ({ getBoundingClientRect: () => pair.current?.getBoundingClientRect() ?? new DOMRect() }),
    [],
  );
  const code = useMemo(
    () =>
      latest && !latest.fromTeam
        ? verificationCode({ subject: latest.subject, text: latest.cleanText })
        : null,
    [latest],
  );
  if (!latest || composing) return null;
  const reply = () => composer.openReply(composer.chat ? "replyAll" : "reply", messageId);
  const forward = () => composer.forward(latest.id);
  if (code) {
    return (
      <Floating ref={pair}>
        <MenuTrigger>
          <Button intent="outline" size="md" className={FLOAT}>
            <IconReply />
            Respond
          </Button>
          <Menu
            placement="top start"
            popover={{ anchor: pairBox, className: "w-(--anchor-width)" }}
          >
            <MenuItem textValue="Reply" onAction={reply}>
              <IconReply data-slot="icon" />
              <MenuLabel>Reply</MenuLabel>
            </MenuItem>
            <MenuItem textValue="Forward" onAction={forward}>
              <IconForward data-slot="icon" />
              <MenuLabel>Forward</MenuLabel>
            </MenuItem>
          </Menu>
        </MenuTrigger>
        <CopyCode code={code} />
      </Floating>
    );
  }
  return (
    <Floating>
      <Button intent="outline" size="md" className={FLOAT} onPress={forward}>
        <IconForward />
        Forward
      </Button>
      <Button intent="primary" size="md" className={FLOAT} onPress={reply}>
        <IconReply />
        Reply
      </Button>
    </Floating>
  );
}

function CopyCode({ code }: { code: string }) {
  const { copy, copied } = useClipboard();
  return (
    <Button intent="primary" size="md" className={FLOAT} onPress={() => copy(code)}>
      {copied ? <IconCheck /> : <IconCopy />}
      Copy code
    </Button>
  );
}

/** New mail, at the list's bottom right, where Reply sits once a thread opens. */
export function FloatingCompose({ onPress }: { onPress: () => void }) {
  return (
    <div className="pointer-events-none absolute end-5 bottom-5 z-20 flex *:pointer-events-auto">
      <Button intent="primary" size="md" className={FLOAT} onPress={onPress}>
        <IconPencil />
        Compose
      </Button>
    </div>
  );
}

function Floating({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute end-5 bottom-full z-20 mb-5 flex gap-2 *:pointer-events-auto"
    >
      {children}
    </div>
  );
}
