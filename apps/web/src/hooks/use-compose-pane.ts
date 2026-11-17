import { useCallback, useSyncExternalStore } from "react";
import type { ComposerFile } from "./use-compose.ts";

/** A sent message's content, handed back to a fresh composer when its send is undone. */
export interface NewMessageDraft {
  mailboxId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  files: ComposerFile[];
}

const listeners = new Set<() => void>();
let current = false;
let draft: NewMessageDraft | undefined;

function set(open: boolean) {
  if (current === open) return;
  current = open;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `[open, close]`. */
export function useComposePane() {
  const open = useSyncExternalStore(subscribe, () => current);
  const close = useCallback(() => {
    draft = undefined;
    set(false);
  }, []);
  return [open, close] as const;
}

/** Opens new mail in its dialog, over the list or the open thread alike. */
export function useOpenCompose() {
  return useCallback(() => set(true), []);
}

/**
 * Opens the dialog again with an undone send's content. False while the dialog is already open
 * (a new message begun since): that one is kept, and the caller hands this one back another way.
 */
export function reopenCompose(content: NewMessageDraft) {
  if (current) return false;
  draft = content;
  set(true);
  return true;
}

/** The handed-back draft, once, for the composer that opens with it. */
export function takeComposeDraft() {
  const taken = draft;
  draft = undefined;
  return taken;
}
