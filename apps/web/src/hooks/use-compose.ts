// Writing mail: what the composer needs, as hooks. Sends go through the outbox like every mail
// action, wait out the member's undo window, and can be cancelled inside it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useAllMailboxes } from "./use-mail.ts";
import {
  cancelSend,
  cannedRepliesQuery,
  composeReplyMutation,
  createDraft,
  customerSearchQuery,
  deleteDraft,
  discardUpload,
  draftsQuery,
  forgetPending,
  forwardMutation,
  handoffMutation,
  newMailMutation,
  renderCannedReply,
  saveDraft,
  signaturesQuery,
  signatureText,
  uploadFile,
  type Draft,
  type DraftContent,
  type NewDraft,
  type SendAttachment,
  type Upload,
} from "../lib/compose.ts";
import { keys } from "../lib/query-keys.ts";
import { settleOutstanding } from "../lib/pending.ts";
import { useKeyedMutation } from "./keyed-mutation.ts";

export type {
  CannedReply,
  CustomerMatch,
  Draft,
  Queued,
  RenderedReply,
  SendAttachment,
} from "../lib/compose.ts";

/** The signature to start a message with on this inbox (the member's own, else the inbox's). */
export function useSignature(mailboxId: string | undefined) {
  const query = useQuery({ ...signaturesQuery(mailboxId ?? ""), enabled: !!mailboxId });
  return { signature: signatureText(query.data), isLoading: query.isLoading };
}

/** The inbox's canned replies and the member's own. */
export function useCannedReplies(mailboxId: string | undefined) {
  return useQuery({ ...cannedRepliesQuery(mailboxId ?? ""), enabled: !!mailboxId });
}

/**
 * `render(replyId)` fills a canned reply in for this conversation: `{ text, missing, setStatus,
 * addTagIds }`. `missing` names variables with no value, for the composer to flag.
 */
export function useRenderCannedReply(threadId: string | undefined) {
  return useCallback(
    (replyId: string) => {
      if (!threadId) throw new Error("a canned reply needs a conversation");
      return renderCannedReply(replyId, threadId);
    },
    [threadId],
  );
}

/** Customers matching what was typed in a recipient field, debounced. */
export function useCustomerSearch(text: string) {
  const q = useDebouncedValue(text.trim(), 150);
  const query = useQuery(customerSearchQuery(q));
  return { customers: q ? (query.data ?? []) : [], isLoading: query.isFetching };
}

/** A file in the composer: uploading, staged, failed, or an original's attachment (forward). */
export interface ComposerFile {
  /** Stable for React. */
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  status: "uploading" | "ready" | "failed";
  /** 0..1 while uploading. */
  progress: number;
  error?: string;
  attachment?: SendAttachment;
}

/**
 * The composer's files. `add(files)` uploads each with progress; `remove(id)` aborts or discards
 * it; `attachments` lists the ready ones for a send; `busy` is true while any is uploading.
 * `keep(list)` seeds it (a forward's originals, a reopened draft).
 */
export function useComposerFiles(mailboxId: string | undefined) {
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  const patch = (id: string, change: Partial<ComposerFile>) =>
    setFiles((list) => list.map((f) => (f.id === id ? { ...f, ...change } : f)));

  const add = useCallback(
    (picked: Iterable<File>) => {
      if (!mailboxId) return;
      for (const file of picked) {
        const id = crypto.randomUUID();
        const abort = new AbortController();
        aborts.current.set(id, abort);
        setFiles((list) => [
          ...list,
          {
            id,
            filename: file.name,
            size: file.size,
            mimeType: file.type,
            status: "uploading",
            progress: 0,
          },
        ]);
        uploadFile(mailboxId, file, {
          signal: abort.signal,
          onProgress: (progress) => patch(id, { progress }),
        })
          .then((upload: Upload) =>
            patch(id, {
              status: "ready",
              progress: 1,
              attachment: { kind: "upload", uploadId: upload.id },
            }),
          )
          .catch((error: Error) => {
            if (error.name !== "AbortError") patch(id, { status: "failed", error: error.message });
          })
          .finally(() => aborts.current.delete(id));
      }
    },
    [mailboxId],
  );

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    setFiles((list) => {
      const file = list.find((f) => f.id === id);
      if (file?.attachment?.kind === "upload") void discardUpload(file.attachment.uploadId);
      return list.filter((f) => f.id !== id);
    });
  }, []);

  /** Clears the list after a send: the uploads now belong to it, so nothing is discarded. */
  const reset = useCallback((next: ComposerFile[] = []) => setFiles(next), []);

  const attachments = useMemo(
    () => files.flatMap((f) => (f.status === "ready" && f.attachment ? [f.attachment] : [])),
    [files],
  );
  return {
    files,
    add,
    remove,
    reset,
    attachments,
    busy: files.some((f) => f.status === "uploading"),
  };
}

/**
 * `mutate({ threadId, text, to?, cc?, bcc?, messageId?, attachments?, draftId? })`. Shows in the
 * thread at once as a pending send, like `useSendReply`.
 */
export function useComposeReply() {
  return useKeyedMutation(composeReplyMutation(useQueryClient()));
}

/** `mutate({ threadId, to, text, messageId?, includeAttachments?, attachments?, draftId? })`. */
export function useForward() {
  return useKeyedMutation(forwardMutation(useQueryClient()));
}

/**
 * `mutate({ threadId, mailboxId, to, text, cc?, bcc?, messageId?, attachments? })`: replies from
 * the member's personal mailbox and hands the shared conversation off to them (ADR 0030).
 */
export function useHandoff() {
  return useKeyedMutation(handoffMutation(useQueryClient()));
}

/**
 * Where a reply on this inbox can go from: the inbox itself first, then, on a shared inbox, the
 * member's own connected personal mailboxes in its workspace, for a hand-off (ADR 0030).
 */
export function useReplyFromMailboxes(inbox: { id: string; address: string }) {
  const all = useAllMailboxes().data ?? [];
  const shared = all.find((m) => m.id === inbox.id && m.kind === "shared");
  const own = shared
    ? all.filter(
        (m) =>
          m.kind === "personal" &&
          m.orgId === shared.orgId &&
          m.role === "owner" &&
          m.status === "active",
      )
    : [];
  return [inbox, ...own.map((m) => ({ id: m.id, address: m.address }))];
}

/** `mutate({ mailboxId, to, subject, text, cc?, bcc?, attachments?, draftId? })`. */
export function useSendNew() {
  return useKeyedMutation(newMailMutation(useQueryClient()));
}

/**
 * `cancel(actionId, pending?)` stops a send inside its undo window and drops its pending bubble.
 * Resolves `true` when it was stopped, `false` when it had already left.
 */
export function useCancelSend() {
  const client = useQueryClient();
  return useCallback(
    async (actionId: string, pending?: { threadId: string; key: string }) => {
      const stopped = await cancelSend(actionId);
      if (stopped) settleOutstanding(actionId);
      if (stopped && pending) forgetPending(client, pending.threadId, pending.key);
      return stopped;
    },
    [client],
  );
}

/** How long autosave waits after the last keystroke. */
/** Every draft on the inbox the switcher shows, or on all of yours, newest first. */
export function useDrafts(mailbox?: string) {
  return useQuery(draftsQuery({ mailboxId: mailbox }));
}

const AUTOSAVE_MS = 800;

/**
 * A shared draft for one composer (ADR 0021: drafts live in Postgres, everyone on the inbox sees
 * them). `draft` is the saved one this composer resumes, if any. `save(content)` autosaves
 * (creating the draft on the first change); a teammate's newer save wins and comes back through
 * `onConflict`. `discard()` deletes it; `id` is what a send passes as `draftId`.
 */
export function useDraft(
  where: Omit<NewDraft, keyof DraftContent> & { threadId?: string | undefined },
  options: {
    onConflict?: (theirs: Draft) => void;
    enabled?: boolean;
    /** Resume only a draft for `sourceMessageId` (a forward always does; a reply to a chosen message). */
    matchSource?: boolean;
  } = {},
) {
  const client = useQueryClient();
  const list = useQuery({
    ...draftsQuery(where.threadId ? { threadId: where.threadId } : { mailboxId: where.mailboxId }),
    enabled: options.enabled !== false,
  });
  // A forward of a named message resumes only that message's draft, never another forward's; a
  // reply to a chosen message, only a reply to that message.
  const matchSource = options.matchSource ?? where.kind === "forward";
  const existing = list.data?.find(
    (d) =>
      d.kind === where.kind &&
      (where.kind === "new" ? !d.threadId : true) &&
      (matchSource && where.sourceMessageId ? d.sourceMessageId === where.sourceMessageId : true),
  );
  const state = useRef<{ id?: string; version?: number; creating?: Promise<Draft | undefined> }>(
    {},
  );
  useEffect(() => {
    if (existing && !state.current.id) {
      state.current = { id: existing.id, version: existing.version };
    }
  }, [existing]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef<DraftContent | null>(null);
  const onConflict = useRef(options.onConflict);
  onConflict.current = options.onConflict;
  const whereRef = useRef(where);
  whereRef.current = where;

  // Saves run one at a time: each needs the version the previous one answered, or two in
  // flight would conflict with each other and the composer would load its own older text.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Bumped when a send takes the draft over, so a save still in flight can't revive it.
  const generation = useRef(0);

  const saveOnce = useCallback(async () => {
    const content = latest.current;
    if (!content) return state.current.id;
    latest.current = null;
    const gen = generation.current;
    // A failed request keeps its content for the next try, unless newer content came since.
    const keep = () => {
      if (gen === generation.current) latest.current ??= content;
    };
    if (!state.current.id) {
      state.current.creating ??= createDraft({ ...whereRef.current, ...content } as NewDraft)
        .then((draft) => {
          if (gen === generation.current) {
            state.current = { id: draft.id, version: draft.version };
            void client.invalidateQueries({ queryKey: keys.draftLists() });
          }
          return draft;
        })
        .catch(() => {
          if (gen === generation.current) state.current.creating = undefined;
          keep();
          return undefined;
        });
      await state.current.creating;
      return state.current.id;
    }
    const result = await saveDraft(state.current.id, state.current.version ?? 1, content).catch(
      () => undefined,
    );
    if (gen !== generation.current) return undefined;
    if (!result) {
      keep();
      return state.current.id;
    }
    if ("conflict" in result) {
      state.current.version = result.conflict.version;
      onConflict.current?.(result.conflict);
    } else {
      state.current.version = result.draft.version;
    }
    return state.current.id;
  }, [client]);

  const flush = useCallback((): Promise<string | undefined> => {
    clearTimeout(timer.current);
    const next = queue.current.then(saveOnce, saveOnce);
    queue.current = next;
    return next;
  }, [saveOnce]);

  const save = useCallback(
    (content: DraftContent) => {
      latest.current = content;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  /** Stops autosave and forgets the draft (a send deletes it on the server). */
  const forget = useCallback(() => {
    clearTimeout(timer.current);
    generation.current++;
    latest.current = null;
    state.current = {};
  }, []);

  /**
   * Hands the draft over to a send: autosave stops, and the answer resolves to the draft's id
   * (once it exists) so the caller can delete it after the send is queued.
   */
  const detach = useCallback(async () => {
    const pending = state.current;
    forget();
    // Out of the cached lists at once (before the first await), so a composer that mounts next
    // (Discard on a shared inbox, Reply again) doesn't resume the draft before the refetch.
    // The cache holds the response (`{ drafts }`); `draftsQuery` selects the list from it.
    const drop = (id: string) =>
      client.setQueriesData<{ drafts: Draft[] }>({ queryKey: keys.draftLists() }, (old) =>
        Array.isArray(old?.drafts)
          ? { ...old, drafts: old.drafts.filter((d) => d.id !== id) }
          : old,
      );
    if (pending.id) drop(pending.id);
    const id = pending.id ?? (await pending.creating)?.id;
    if (id) drop(id);
    return id;
  }, [client, forget]);

  /** Deletes a draft `detach` handed over. */
  const remove = useCallback(
    async (id: string | undefined) => {
      if (id) await deleteDraft(id);
      void client.invalidateQueries({ queryKey: keys.draftLists() });
    },
    [client],
  );

  const discard = useCallback(async () => {
    const id = state.current.id ?? (await state.current.creating)?.id;
    forget();
    if (id) await deleteDraft(id);
    void client.invalidateQueries({ queryKey: keys.draftLists() });
  }, [client, forget]);

  // Leaving the composer saves what was typed since the last autosave.
  useEffect(() => () => void flush(), [flush]);

  return {
    draft: existing,
    isLoading: list.isLoading,
    save,
    /** Saves now and answers the draft id (for a send from the draft). */
    flush,
    forget,
    detach,
    remove,
    discard,
  };
}
