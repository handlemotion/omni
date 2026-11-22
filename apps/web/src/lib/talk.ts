import { WORKSPACE_HEADER, type Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import { currentWorkspaceId, withWorkspace, workspaceHeaders } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";

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

export const talkMessagesQuery = (threadId: string) =>
  infiniteQueryOptions({
    queryKey: keys.talkMessages(threadId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      call(
        api.talk.threads[":id"].messages.$get(
          { param: { id: threadId }, query: pageParam ? { before: pageParam } : {} },
          { init: { signal } },
        ),
      ),
    getNextPageParam: (page: TalkMessagesResponse) =>
      page.more ? page.messages.at(-1)?.id : undefined,
  });

/**
 * Who the stack shows: online teammates, unread ones first, then by name; the shown ones and
 * how many more there are.
 */
export function stackOf(people: readonly TalkPerson[]) {
  const online = people
    .filter((p) => p.online)
    .toSorted(
      (a, b) => Number(b.unread > 0) - Number(a.unread > 0) || a.name.localeCompare(b.name),
    );
  return { shown: online.slice(0, STACK_MAX), more: Math.max(online.length - STACK_MAX, 0) };
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

/** A note and the workspace it was written in, fixed when it was sent rather than when it goes. */
export interface NoteToSend {
  body: string;
  workspaceId: string | undefined;
}

export const noteToSend = (body: string) =>
  ({ body, workspaceId: currentWorkspaceId() }) satisfies NoteToSend;

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

async function react(messageId: string, emoji: string, on: boolean) {
  const route = api.talk.messages[":id"].reactions[":emoji"];
  const args = { param: { id: messageId, emoji } };
  await call(on ? route.$put(args) : route.$delete(args));
}

/** Where a note's file opens: Storage's own doors decide, after Talk checks the note is yours. */
export const fileUrl = (messageId: string) =>
  withWorkspace(api.talk.messages[":id"].file.$url({ param: { id: messageId } }).toString());

export const isImage = (mimeType: string | null) => Boolean(mimeType?.startsWith("image/"));

/** Puts a note the server just answered at the top of its thread's first page. */
export function addMessage(client: QueryClient, message: TalkMessage) {
  client.setQueryData<InfiniteData<TalkMessagesResponse>>(
    keys.talkMessages(message.threadId),
    (data) => {
      if (!data) return data;
      const [first, ...rest] = data.pages;
      if (!first || first.messages.some((m) => m.id === message.id)) return data;
      return { ...data, pages: [{ ...first, messages: [message, ...first.messages] }, ...rest] };
    },
  );
}

/** A teammate came online or left: their dot follows, with no refetch. */
export function setOnline(client: QueryClient, memberId: string, online: boolean) {
  client.setQueryData<TalkPerson[]>(keys.talkPeople(), (people) =>
    people?.map((p) => (p.memberId === memberId ? { ...p, online } : p)),
  );
}

const peopleChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: keys.talkPeople() });

/**
 * `mutate(noteToSend(body))`: notes to one thread go one after another, in the order they were
 * sent, each to the workspace it was written in.
 */
export const sendNoteMutation = (client: QueryClient, threadId: string | undefined) =>
  mutationOptions({
    mutationFn: (note: NoteToSend) => sendNote(threadId!, note),
    scope: { id: `talk-notes:${threadId}` },
    onSuccess: (message) => {
      addMessage(client, message);
      void peopleChanged(client);
    },
  });

/** `mutate(files)`: each file into your Drive, shared with the other one, then into the thread. */
export const sendFilesMutation = (client: QueryClient, threadId: string | undefined) =>
  mutationOptions({
    mutationFn: async (files: File[]) => {
      const workspaceId = currentWorkspaceId();
      for (const file of files) addMessage(client, await sendFile(threadId!, file, workspaceId));
    },
    onSettled: () => peopleChanged(client),
  });

/** `mutate({ messageId, emoji, on })`: adds or takes away your reaction. */
export const reactMutation = (client: QueryClient, threadId: string) =>
  mutationOptions({
    mutationFn: ({ messageId, emoji, on }: { messageId: string; emoji: string; on: boolean }) =>
      react(messageId, emoji, on),
    onSettled: () => client.invalidateQueries({ queryKey: keys.talkMessages(threadId) }),
  });

/** Reads the thread up to now. */
export async function readThread(client: QueryClient, threadId: string) {
  await markRead(threadId);
  await peopleChanged(client);
}
