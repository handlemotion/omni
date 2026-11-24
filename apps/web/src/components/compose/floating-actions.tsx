import type { Thread } from "@omni/client";
import { verificationCode } from "@omni/mail-core/verification-code";
import { type ReactNode, useMemo } from "react";
import { IconCheck, IconCopy } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { useClipboard } from "@/hooks/use-clipboard";
import { useComposerState } from "./composer-state.tsx";

const FLOAT = "shadow-(--shadow-overlay)";

/**
 * Copy code, at the reading pane's bottom right, when the open thread's latest email is a sign-in
 * or verification email: nobody answers those. Every other thread has nothing here; each message
 * carries its own Reply and Forward. Gone while a composer is open.
 */
export function FloatingCopyCode({ thread, messageId }: { thread: Thread; messageId?: string }) {
  const composer = useComposerState();
  const latest = thread.messages.find((m) => m.id === messageId) ?? thread.messages.at(-1);
  const composing = composer.chatOpen || (composer.email && composer.mode === "public");
  const code = useMemo(
    () =>
      latest && !latest.fromTeam
        ? verificationCode({ subject: latest.subject, text: latest.cleanText })
        : null,
    [latest],
  );
  if (!code || composing) return null;
  return (
    <Floating>
      <CopyCode code={code} />
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

function Floating({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute end-5 bottom-full z-20 mb-5 flex gap-2 *:pointer-events-auto">
      {children}
    </div>
  );
}
