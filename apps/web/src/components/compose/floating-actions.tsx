// Reply and Forward, floating at the reading column's bottom right over an open thread; Compose,
// at the list's bottom right while no thread is open (with one open, the list header's pen).
import type { ReactNode } from "react";
import { IconForward, IconPencil, IconReply } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/types.ts";
import { useComposerState } from "./composer-state.tsx";

// Raised over whatever scrolls under it: the overlay shadow, as a menu or popover would.
const FLOAT = "shadow-(--shadow-overlay)";

/**
 * Reply and Forward for the open thread, at the reading pane's bottom right. Gone while a
 * composer is docked there (an email, or a shared conversation's hidden notes).
 */
export function FloatingReply({ thread, messageId }: { thread: Thread; messageId?: string }) {
  const composer = useComposerState();
  // The email on screen, in the email view; the latest otherwise.
  const latest = thread.messages.find((m) => m.id === messageId) ?? thread.messages.at(-1);
  // Back once no composer shows: also after a send from the email view, whose notes stay away.
  const composing = composer.chatOpen || (composer.email && composer.mode === "public");
  if (!latest || composing) return null;
  return (
    <Floating>
      <Button
        intent="outline"
        size="md"
        className={FLOAT}
        onPress={() => composer.forward(latest.id)}
      >
        <IconForward />
        Forward
      </Button>
      <Button
        intent="primary"
        size="md"
        className={FLOAT}
        // A shared inbox answers everyone outside the team, as a message's own Reply does.
        onPress={() => composer.openReply(composer.chat ? "replyAll" : "reply", messageId)}
      >
        <IconReply />
        Reply
      </Button>
    </Floating>
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

/** Sits 20px over the top of its (sticky, bottom) parent and 20px in from its end. */
function Floating({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute end-5 bottom-full z-20 mb-5 flex gap-2 *:pointer-events-auto">
      {children}
    </div>
  );
}
