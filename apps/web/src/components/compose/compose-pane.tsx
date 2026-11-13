import { IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useAllMailboxes } from "@/hooks/use-mail.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useSearch } from "@tanstack/react-router";
import { NewMessageComposer } from "./composer.tsx";

/**
 * Every address you can send from, the active workspace's first: without a chosen mailbox the
 * composer sends from the first one, and that must not be another workspace's address.
 */
export function useComposeMailboxes() {
  const { member } = useMember();
  const all = useAllMailboxes().data ?? [];
  return [
    ...all.filter((m) => m.orgId === member.orgId),
    ...all.filter((m) => m.orgId !== member.orgId),
  ];
}

/**
 * New mail in the reading pane beside the list, laid out like an open conversation: the same
 * toolbar row (with close where the thread's actions sit), then the composer in the messages'
 * reading column.
 */
export function ComposePane({ onClose }: { onClose: () => void }) {
  const mailboxes = useComposeMailboxes();
  // From the mailbox the switcher shows, when it shows one.
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const [fullScreen] = useFullScreen();
  // Full screen, the sidebar's own edge is the only line: a second one beside it would double up.
  const edge = fullScreen ? "" : "border-s";
  return (
    <section aria-label="New message" className="flex min-w-0 flex-1 flex-col">
      {/* The conversation toolbar's row: same height, lift and inset (see `Actions`). */}
      <div
        className={`relative flex h-10.5 shrink-0 items-center border-b pb-0.5 ${fullScreen ? "" : "border-s border-s-transparent"}`}
      >
        <div className="absolute inset-y-0 end-1.5 flex items-center pb-0.5">
          <TooltipTrigger delay={400}>
            <Button intent="ghost" size="sq-sm-lg" aria-label="Close" onPress={onClose}>
              <IconX />
            </Button>
            <Tooltip>Close</Tooltip>
          </TooltipTrigger>
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-none ${edge}`}>
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          <NewMessageComposer mailboxes={mailboxes} initial={{ mailboxId: mailbox }} />
        </div>
      </div>
    </section>
  );
}
