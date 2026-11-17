import { useAllMailboxes } from "@/hooks/use-mail.ts";
import { useMember } from "@/hooks/use-session.ts";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { reopenCompose, takeComposeDraft, useComposePane } from "@/hooks/use-compose-pane.ts";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
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
 * New mail in a dialog over the page, like a command palette: the title row with its close, then
 * the composer filling the rest. Replies stay under their conversation. Send closes it; an undo
 * opens it again holding what was sent.
 */
export function ComposeDialog() {
  const [open, close] = useComposePane();
  return (
    <Dialog
      aria-label="New email"
      size="3xl"
      bare
      isOpen={open}
      onOpenChange={(next) => !next && close()}
      className="h-[min(--spacing(160),calc(100dvh-2rem))]"
    >
      <ComposeDialogBody onSent={close} />
    </Dialog>
  );
}

function ComposeDialogBody({ onSent }: { onSent: () => void }) {
  const mailboxes = useComposeMailboxes();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const [restored] = useState(takeComposeDraft);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center border-b px-3 pe-12">
        <DialogTitle>New email</DialogTitle>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none">
        <NewMessageComposer
          mailboxes={mailboxes}
          initial={{ mailboxId: mailbox }}
          restored={restored}
          onSent={onSent}
          onUndone={reopenCompose}
        />
      </div>
    </>
  );
}
