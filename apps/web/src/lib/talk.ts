import { WORKSPACE_HEADER, type Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import { currentWorkspaceId, withWorkspace, workspaceHeaders } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";
import {
  addMessage,
  pendingId,
  setReactions,
  settlePending,
  lastNoteAt,
  threadRead,
  toggledReactions,
} from "./talk-cache.ts";

type Talk = Api["talk"];
export type TalkPerson = InferResponseType<Talk["people"]["$get"], 200>["people"][number];
export type TalkMessagesResponse = InferResponseType<
  Talk["threads"][":id"]["messages"]["$get"],
  200
>;
export type TalkMessage = TalkMessagesResponse["messages"][number];
type FileSent = InferResponseType<Talk["threads"][":id"]["files"]["$post"], 201>;

/** At most this many teammates show in the stack; the rest are `+n`. */
export const STACK_MAX = 3;

export const talkPeopleQuery = () =>
  queryOptions({
    queryKey: keys.talkPeople(),
    queryFn: async ({ signal }) =>
      (await call(api.talk.people.$get({}, { init: { signal } }))).people,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

const OLDER_PAGE = "100";

/**
 * A thread's notes, newest page first. Realtime keeps a loaded thread current (notes and reactions
 * arrive in their events, and a reconnect refetches Talk), so it is fresh for minutes: reopening
 * the window shows it at once, and never refetches every page it has.
 */
export const talkMessagesQuery = (threadId: string) =>
  infiniteQueryOptions({
    queryKey: keys.talkMessages(threadId),
    initialPageParam: undefined as string | undefined,
    staleTime: 5 * 60_000,
    // WARNING: sharing matches notes by index, so a note on top would copy every other one.
    structuralSharing: false,
    // WARNING: no abort signal: a window remounting would cancel a refetch a reconnect asked for.
    queryFn: ({ pageParam }) =>
      call(
        api.talk.threads[":id"].messages.$get({
          param: { id: threadId },
          query: pageParam ? { before: pageParam, limit: OLDER_PAGE } : {},
        }),
      ),
    getNextPageParam: (page: TalkMessagesResponse) =>
      page.more ? page.messages.at(-1)?.id : undefined,
  });

/**
 * Who the stack shows: every teammate, online or not, so anyone can be written to; unread ones
 * first, then those online, then by name. The shown ones and how many more there are.
 */
export function stackOf(people: readonly TalkPerson[]) {
  const sorted = people.toSorted(
    (a, b) =>
      Number(b.unread > 0) - Number(a.unread > 0) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
  );
  return { shown: sorted.slice(0, STACK_MAX), more: Math.max(sorted.length - STACK_MAX, 0) };
}

/** Everyone, for the full list: online first, then the rest, each by name. */
export const everyoneOf = (people: readonly TalkPerson[]) =>
  people.toSorted((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

async function openThread(memberId: string) {
  return (await call(api.talk.threads.$post({ json: { memberId } }))).thread;
}

/** The thread with a teammate, made on first use; the same thread every time after. */
export const talkThreadQuery = (memberId: string) =>
  queryOptions({
    queryKey: keys.talkThread(memberId),
    queryFn: () => openThread(memberId),
    staleTime: Infinity,
  });

/**
 * A note and the workspace it was written in, fixed when it was sent rather than when it goes,
 * with who wrote it and the id it shows under until the server stores it.
 */
export interface NoteToSend {
  body: string;
  workspaceId: string | undefined;
  authorMemberId: string;
  pendingId: string;
}

export const noteToSend = (body: string, authorMemberId: string) =>
  ({
    body,
    workspaceId: currentWorkspaceId(),
    authorMemberId,
    pendingId: pendingId(),
  }) satisfies NoteToSend;

const inWorkspace = (workspaceId: string | undefined) =>
  workspaceId ? { headers: { [WORKSPACE_HEADER]: workspaceId } } : {};

async function sendNote(threadId: string, note: NoteToSend) {
  const sent = api.talk.threads[":id"].messages.$post(
    { param: { id: threadId }, json: { body: note.body } },
    inWorkspace(note.workspaceId),
  );
  return (await call(sent)).message;
}

async function sendFile(threadId: string, file: File, workspaceId: string | undefined) {
  const url = api.talk.threads[":id"].files.$url({
    param: { id: threadId },
    query: { name: file.name },
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...workspaceHeaders(),
      ...inWorkspace(workspaceId).headers,
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!response.ok) throw new ApiError(response.status, `sending ${file.name} failed`);
  return ((await response.json()) as FileSent).message;
}

async function markRead(threadId: string) {
  await call(api.talk.threads[":id"].read.$put({ param: { id: threadId } }));
}

async function react(reacting: Reacting) {
  const route = api.talk.messages[":id"].reactions[":emoji"];
  const args = { param: { id: reacting.messageId, emoji: reacting.emoji } };
  const where = inWorkspace(reacting.workspaceId);
  await call(reacting.on ? route.$put(args, where) : route.$delete(args, where));
}

/** Where a note's file opens: Storage's own doors decide, after Talk checks the note is yours. */
export const fileUrl = (messageId: string) =>
  withWorkspace(api.talk.messages[":id"].file.$url({ param: { id: messageId } }).toString());

export const isImage = (mimeType: string | null) => Boolean(mimeType?.startsWith("image/"));

/** A teammate came online or left: their dot follows, with no refetch. */
export function setOnline(client: QueryClient, memberId: string, online: boolean) {
  client.setQueryData<TalkPerson[]>(keys.talkPeople(), (people) =>
    people?.map((p) => (p.memberId === memberId ? { ...p, online } : p)),
  );
}

const threadWith = async (client: QueryClient, memberId: string, threadId: string | undefined) =>
  threadId ?? (await client.fetchQuery(talkThreadQuery(memberId))).id;

/**
 * `mutate(noteToSend(body, meId))`: the note shows at once, then notes to one teammate go one
 * after another, in the order they were sent, each to the workspace it was written in; the first
 * one makes the thread if need be.
 */
export const sendNoteMutation = (
  client: QueryClient,
  memberId: string,
  threadId: string | undefined,
) =>
  mutationOptions({
    mutationFn: async (note: NoteToSend) =>
      sendNote(await threadWith(client, memberId, threadId), note),
    scope: { id: `talk-notes:${memberId}` },
    onMutate: (note) => {
      if (!threadId) return;
      addMessage(client, {
        id: note.pendingId,
        threadId,
        authorMemberId: note.authorMemberId,
        body: note.body,
        file: null,
        reactions: [],
        reactionsVersion: 0,
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: (message, note) => settlePending(client, message.threadId, note.pendingId, message),
    onError: (_error, note) => threadId && settlePending(client, threadId, note.pendingId, null),
  });

/** `mutate(files)`: each file into your Drive, shared with the other one, then into the thread. */
export const sendFilesMutation = (
  client: QueryClient,
  memberId: string,
  threadId: string | undefined,
) =>
  mutationOptions({
    mutationFn: async (files: File[]) => {
      const workspaceId = currentWorkspaceId();
      const id = await threadWith(client, memberId, threadId);
      for (const file of files) addMessage(client, await sendFile(id, file, workspaceId));
    },
  });

/** A reaction and the workspace it was made in, fixed when it was clicked rather than when it goes. */
export interface Reacting {
  messageId: string;
  emoji: string;
  on: boolean;
  meId: string;
  workspaceId: string | undefined;
}

export const reacting = (change: Omit<Reacting, "workspaceId">) =>
  ({ ...change, workspaceId: currentWorkspaceId() }) satisfies Reacting;

/**
 * `mutate(reacting({ messageId, emoji, on, meId }))`: your reaction shows at once, then goes, after
 * the ones before it in the thread, so a quick on-then-off ends off, to the workspace it was made in.
 */
export const reactMutation = (client: QueryClient, threadId: string) =>
  mutationOptions({
    mutationFn: react,
    scope: { id: `talk-react:${threadId}` },
    onMutate: ({ messageId, emoji, on, meId }) => {
      const queryKey = keys.talkMessages(threadId);
      setReactions(client, threadId, messageId, (now) => toggledReactions(now, meId, emoji, on));
      return { queryKey };
    },
    onError: (_error, _reacting, context) =>
      context && client.invalidateQueries({ queryKey: context.queryKey }),
  });

/** Reads the thread up to now. */
export async function readThread(client: QueryClient, threadId: string) {
  const newest = lastNoteAt(client, threadId);
  await markRead(threadId);
  threadRead(client, threadId, lastNoteAt(client, threadId) === newest ? undefined : newest);
}
