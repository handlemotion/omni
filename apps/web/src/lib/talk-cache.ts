import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { TalkMessage, TalkMessagesResponse, TalkPerson } from "./talk.ts";

type Pages = InfiniteData<TalkMessagesResponse>;

const PENDING = "pending:";
export const isPending = (messageId: string) => messageId.startsWith(PENDING);
export const pendingId = () => `${PENDING}${crypto.randomUUID()}`;

function editPages(client: QueryClient, threadId: string, edit: (data: Pages) => Pages) {
  const queryKey = keys.talkMessages(threadId);
  const settle = () => {
    if (!client.getQueryData(queryKey)) return void client.invalidateQueries({ queryKey });
    const stale = client.getQueryCache().find({ queryKey, exact: true })?.state.isInvalidated;
    client.setQueryData<Pages>(queryKey, (data) => data && edit(data));
    // WARNING: an edit marks the thread fresh; one a reconnect left stale must still refetch.
    if (stale) void client.invalidateQueries({ queryKey, refetchType: "none" });
  };
  settle();
  const cache = client.getQueryCache();
  const query = cache.find({ queryKey, exact: true });
  if (query?.state.fetchStatus !== "fetching") return;
  // WARNING: a fetch in flight answers from what it started with; apply the change again after it.
  const stop = cache.subscribe((event) => {
    if (event.query !== query || query.state.fetchStatus === "fetching") return;
    stop();
    settle();
  });
}

const has = (data: Pages, messageId: string) =>
  data.pages.some((page) => page.messages.some((m) => m.id === messageId));

/** Puts a note at the top of its thread's first page, once; a known one is left as it is. */
export function addMessage(client: QueryClient, message: TalkMessage) {
  editPages(client, message.threadId, (data) => withMessage(data, message));
}

function withMessage(data: Pages, message: TalkMessage) {
  const [first, ...rest] = data.pages;
  if (!first || has(data, message.id)) return data;
  const twin = first.messages.findLastIndex(
    (m) =>
      isPending(m.id) && m.authorMemberId === message.authorMemberId && m.body === message.body,
  );
  const messages = twin === -1 ? [message, ...first.messages] : first.messages.with(twin, message);
  return { ...data, pages: [{ ...first, messages: newestFirst(messages) }, ...rest] };
}

function newestFirst(messages: TalkMessage[]) {
  const stored = messages.filter((m) => !isPending(m.id));
  const sorted = stored.every((m, i) => i === 0 || stored[i - 1]!.id > m.id);
  if (sorted && messages.length === stored.length) return messages;
  const pending = messages.filter((m) => isPending(m.id));
  return [...pending, ...stored.toSorted((a, b) => (a.id < b.id ? 1 : -1))];
}

/** Swaps a note on its way for the one the server stored, or drops it (failed, or already in). */
export function settlePending(
  client: QueryClient,
  threadId: string,
  pending: string,
  message: TalkMessage | null,
) {
  editPages(client, threadId, (data) => {
    const drop = !message || has(data, message.id);
    if (!drop && !has(data, pending)) return withMessage(data, message);
    return {
      ...data,
      pages: data.pages.map((page) =>
        page.messages.some((m) => m.id === pending)
          ? {
              ...page,
              messages: drop
                ? page.messages.filter((m) => m.id !== pending)
                : newestFirst(page.messages.map((m) => (m.id === pending ? message : m))),
            }
          : page,
      ),
    };
  });
}

const versionOf = (message: TalkMessage) => message.reactionsVersion ?? 0;

/**
 * A note's reactions as they now are (or a change to them, which a fetch in flight replays on what
 * it brings), wherever it sits in the loaded pages; a `version` lower than
 * the one the note already has is stale and left out. False when the thread is loaded without that
 * note (its own event has not come yet), so the caller can fetch it.
 */
export function setReactions(
  client: QueryClient,
  threadId: string,
  messageId: string,
  reactions:
    | TalkMessage["reactions"]
    | ((now: TalkMessage["reactions"]) => TalkMessage["reactions"]),
  version?: number,
) {
  const loaded = client.getQueryData<Pages>(keys.talkMessages(threadId));
  if (loaded && !has(loaded, messageId)) return false;
  const apply = (m: TalkMessage) =>
    m.id !== messageId || (version !== undefined && versionOf(m) >= version)
      ? m
      : {
          ...m,
          reactions: typeof reactions === "function" ? reactions(m.reactions) : reactions,
          reactionsVersion: version ?? m.reactionsVersion,
        };
  editPages(client, threadId, (data) => ({
    ...data,
    pages: data.pages.map((page) =>
      page.messages.some((m) => m.id === messageId)
        ? { ...page, messages: page.messages.map(apply) }
        : page,
    ),
  }));
  return true;
}

/** `memberId`'s `emoji` on a note, on or off, as the server will have it. */
export function toggledReactions(
  reactions: TalkMessage["reactions"],
  memberId: string,
  emoji: string,
  on: boolean,
) {
  const others = (ids: string[]) => ids.filter((id) => id !== memberId);
  const next = reactions
    .map((r) =>
      r.emoji === emoji
        ? { ...r, memberIds: on ? [...others(r.memberIds), memberId] : others(r.memberIds) }
        : r,
    )
    .filter((r) => r.memberIds.length > 0);
  return on && !next.some((r) => r.emoji === emoji)
    ? [...next, { emoji, memberIds: [memberId] }]
    : next;
}

/**
 * The thread's newest page, merged into what is loaded: new notes go on top, known ones take the
 * server's reactions. For an event that names a note without carrying it.
 */
export async function fetchNewest(client: QueryClient, threadId: string) {
  if (!client.getQueryData(keys.talkMessages(threadId))) return;
  const page = await call(
    api.talk.threads[":id"].messages.$get({ param: { id: threadId }, query: {} }),
  );
  const fresh = new Map(page.messages.map((m) => [m.id, m]));
  const merged = (m: TalkMessage) => {
    const got = fresh.get(m.id);
    if (!got) return m;
    return versionOf(m) > versionOf(got)
      ? { ...got, reactions: m.reactions, reactionsVersion: m.reactionsVersion }
      : got;
  };
  editPages(client, threadId, (data) => {
    const known = new Set(data.pages.flatMap((p) => p.messages.map((m) => m.id)));
    const added = page.messages.filter((m) => !known.has(m.id));
    return {
      ...data,
      pages: data.pages.map((p, i) => {
        const messages = p.messages.map(merged);
        return i === 0
          ? { ...p, messages: newestFirst([...added, ...messages]) }
          : { ...p, messages };
      }),
    };
  });
}

const editPeople = (client: QueryClient, edit: (person: TalkPerson) => TalkPerson) =>
  client.setQueryData<TalkPerson[]>(keys.talkPeople(), (people) => people?.map(edit));

/**
 * A note went by in a thread: the list keeps when, and a note from them you are not looking at
 * fetches the unread counts again. A thread the list does not know yet is fetched too.
 */
export function noteWentBy(
  client: QueryClient,
  event: { threadId: string; fromMemberId: string; createdAt: string | undefined },
  looking: boolean,
) {
  const people = client.getQueryData<TalkPerson[]>(keys.talkPeople());
  const person = people?.find((p) => p.threadId === event.threadId);
  if (
    person &&
    event.createdAt &&
    !(person.lastMessageAt && person.lastMessageAt >= event.createdAt)
  ) {
    editPeople(client, (p) => (p === person ? { ...p, lastMessageAt: event.createdAt! } : p));
  }
  if (person && (person.memberId !== event.fromMemberId || looking)) return;
  // WARNING: count from the server, never +1: a fetch may already hold this note, or predate it.
  void client.invalidateQueries({ queryKey: keys.talkPeople() });
}

/**
 * You read the thread up to `readAt`: nothing in it is unread any more, unless a note went by after
 * that, in which case the counts are fetched again. Without `readAt`, everything is read.
 */
export function threadRead(client: QueryClient, threadId: string, readAt: string | undefined) {
  const queryKey = keys.talkPeople();
  // WARNING: a count already on its way may predate this read; ask again, after it.
  if (client.getQueryCache().find({ queryKey, exact: true })?.state.fetchStatus === "fetching") {
    return void client.invalidateQueries({ queryKey });
  }
  const people = client.getQueryData<TalkPerson[]>(queryKey);
  const person = people?.find((p) => p.threadId === threadId);
  if (!person?.unread) return;
  if (readAt && person.lastMessageAt && person.lastMessageAt > readAt) {
    return void client.invalidateQueries({ queryKey: keys.talkPeople() });
  }
  editPeople(client, (p) => (p === person ? { ...p, unread: 0 } : p));
}

/** When a thread's newest note went by, as far as the people list knows. */
export const lastNoteAt = (client: QueryClient, threadId: string) =>
  client.getQueryData<TalkPerson[]>(keys.talkPeople())?.find((p) => p.threadId === threadId)
    ?.lastMessageAt ?? undefined;

/**
 * Keeps only the thread's newest page once its window closes, so opening it again draws one page
 * of notes; older ones load again ahead of the scroll.
 */
export function keepNewestPage(client: QueryClient, threadId: string) {
  const queryKey = keys.talkMessages(threadId);
  if ((client.getQueryData<Pages>(queryKey)?.pages.length ?? 0) < 2) return;
  const stale = client.getQueryCache().find({ queryKey, exact: true })?.state.isInvalidated;
  client.setQueryData<Pages>(
    queryKey,
    (data) => data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
  );
  if (stale) void client.invalidateQueries({ queryKey, refetchType: "none" });
}
