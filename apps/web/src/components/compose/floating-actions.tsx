// Reply and Forward, floating at the reading column's bottom right over an open personal thread.
// New mail is the list header's pen and the sidebar's Compose.
import type { ReactNode } from "react";
import { IconForward, IconReply } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/types.ts";
import { useComposerState } from "./composer-state.tsx";

// Raised over whatever scrolls under it: the overlay shadow, as a menu or popover would.
const FLOAT = "shadow-(--shadow-overlay)";

/**
 * Reply and Forward for the open thread, at the reading pane's bottom right. Gone while a
 * composer is docked there (an email, or a shared conversation's hidden notes).
 */
export function FloatingReply({ thread }: { thread: Thread }) {
  const composer = useComposerState();
  const latest = thread.messages.at(-1);
  if (!latest || composer.open) return null;
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
        onPress={() => composer.openReply(composer.chat ? "replyAll" : "reply")}
      >
        <IconReply />
        Reply
      </Button>
    </Floating>
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
