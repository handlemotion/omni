import { withWorkspace } from "./current-workspace.ts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { calendarTaskKeys } from "./calendar-tasks.ts";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, ApiError, call } from "./api.ts";
import { keys } from "./query-keys.ts";

type Meetings = Api["meetings"];
type Json<T> = T extends { json: infer J } ? J : never;

export type MeetingGroup = InferResponseType<Meetings["groups"]["$get"], 200>["groups"][number];
export type MeetingGroupPage = InferResponseType<Meetings["groups"][":key"]["$get"], 200>;
export type Meeting = InferResponseType<Meetings[":id"]["$get"], 200>;
export type MeetingSegment = InferResponseType<
  Meetings[":id"]["transcript"]["$get"],
  200
>["segments"][number];
export type MeetingAction = Meeting["actions"][number];
export type MeetingSpeaker = Meeting["speakers"][number];
export type MeetingChange = Json<InferRequestType<Meetings[":id"]["$patch"]>>;
export type StartMeeting = Json<InferRequestType<Meetings["$post"]>>;

export const meetingKeys = {
  all: () => keys.meetings(),
  enabled: () => [...meetingKeys.all(), "enabled"] as const,
  groups: () => [...meetingKeys.all(), "groups"] as const,
  group: (key: string) => [...meetingKeys.all(), "group", key] as const,
  list: (group: string) => [...meetingKeys.all(), "list", group] as const,
  meeting: (id: string) => [...meetingKeys.all(), "meeting", id] as const,
  transcript: (id: string) => [...meetingKeys.all(), "transcript", id] as const,
  writes: () => [...meetingKeys.all(), "write"] as const,
};

/**
 * Whether Meetings is on for this workspace: the Worker answers `not_found` on every meetings
 * route while no transcription engine is configured.
 */
export const meetingsEnabledQuery = () =>
  queryOptions({
    queryKey: meetingKeys.enabled(),
    queryFn: async ({ signal }) => {
      try {
        await call(api.meetings.groups.$get({ query: { limit: "1" } }, { init: { signal } }));
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return false;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
  });

const PAGE = 50;

/** The groups, by when they last met, newest first, a page at a time. */
export const meetingGroupsQuery = () =>
  infiniteQueryOptions({
    queryKey: meetingKeys.groups(),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.meetings.groups.$get(
          { query: { limit: String(PAGE), ...(pageParam ? { before: pageParam } : {}) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) =>
      page.groups.length < PAGE ? null : (page.groups.at(-1)?.lastStartedAt ?? null),
    select: (data) => data.pages.flatMap((page) => page.groups),
  });

export const meetingGroupQuery = (key: string) =>
  queryOptions({
    queryKey: meetingKeys.group(key),
    queryFn: ({ signal }) =>
      call(api.meetings.groups[":key"].$get({ param: { key } }, { init: { signal } })),
  });

/** Every meeting in a group, newest first, whatever its status, a page at a time. */
export const meetingListQuery = (group: string) =>
  infiniteQueryOptions({
    queryKey: meetingKeys.list(group),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.meetings.$get(
          { query: { group, limit: String(PAGE), ...(pageParam ? { before: pageParam } : {}) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) =>
      page.meetings.length < PAGE ? null : (page.meetings.at(-1)?.startedAt ?? null),
    select: (data) => data.pages.flatMap((page) => page.meetings),
  });

export const meetingQuery = (id: string) =>
  queryOptions({
    queryKey: meetingKeys.meeting(id),
    queryFn: ({ signal }) =>
      call(api.meetings[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const meetingTranscriptQuery = (id: string) =>
  queryOptions({
    queryKey: meetingKeys.transcript(id),
    queryFn: ({ signal }) =>
      call(api.meetings[":id"].transcript.$get({ param: { id } }, { init: { signal } })),
    select: (body) => body.segments,
  });

/** Where the meeting's recording plays from; the Worker checks the meeting's grants. */
export const meetingAudioUrl = (id: string) =>
  withWorkspace(api.meetings[":id"].audio.$url({ param: { id } }).toString());

/** Every meetings read is stale after a write or a `meetings.changed`. */
export const meetingsChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: meetingKeys.all() });

const write = <I, R>(client: QueryClient, fn: (input: I) => Promise<R>) =>
  mutationOptions({
    mutationKey: meetingKeys.writes(),
    mutationFn: fn,
    onSettled: () => meetingsChanged(client),
  });

export const renameSpeakerMutation = (client: QueryClient) =>
  write(client, (input: { id: string; label: string; name: string; address?: string | null }) =>
    call(
      api.meetings[":id"].speakers[":label"].$put({
        param: { id: input.id, label: input.label },
        json: { name: input.name, address: input.address ?? null },
      }),
    ),
  );

/** Accepting a task puts it in the calendar, so the calendar's task lists are stale too. */
export const decideActionMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: meetingKeys.writes(),
    mutationFn: (input: { id: string; accept: boolean }) =>
      call(
        api.meetings.actions[":id"][":decision{accept|dismiss}"].$post({
          param: { id: input.id, decision: input.accept ? "accept" : "dismiss" },
        }),
      ),
    onSettled: () =>
      Promise.all([
        meetingsChanged(client),
        client.invalidateQueries({ queryKey: calendarTaskKeys.all() }),
      ]),
  });

export const changeMeetingMutation = (client: QueryClient) =>
  write(client, (input: { id: string; change: MeetingChange }) =>
    call(api.meetings[":id"].$patch({ param: { id: input.id }, json: input.change })),
  );

export const grantMeetingMutation = (client: QueryClient) =>
  write(client, (input: { id: string; address: string; role: "viewer" | "editor" }) =>
    call(
      api.meetings[":id"].grants[":address"].$put({
        param: { id: input.id, address: input.address },
        json: { role: input.role },
      }),
    ),
  );

export const revokeMeetingMutation = (client: QueryClient) =>
  write(client, (input: { id: string; address: string }) =>
    call(api.meetings[":id"].grants[":address"].$delete({ param: input })),
  );

export const retryMeetingMutation = (client: QueryClient) =>
  write(client, (id: string) => call(api.meetings[":id"].retry.$post({ param: { id } })));

export const deleteMeetingMutation = (client: QueryClient) =>
  write(client, (id: string) => call(api.meetings[":id"].$delete({ param: { id } })));

/** What kind of group a key names: a recurring event, an outside company, or one meeting. */
export const groupKind = (key: string) =>
  key.startsWith("series:") ? "series" : key.startsWith("domain:") ? "domain" : "meeting";

/** A group's name: the company's domain, else its latest meeting's title. */
export const groupTitle = (group: { groupKey: string; lastTitle: string | null }) =>
  groupKind(group.groupKey) === "domain"
    ? group.groupKey.slice("domain:".length)
    : (group.lastTitle ?? "Untitled meeting");

/** `mm:ss`, or `h:mm:ss` from an hour on: a moment in a meeting. */
export function meetingClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

export const meetingPath = (id: string) => `/meetings/${encodeURIComponent(id)}`;
export const meetingGroupPath = (key: string) => `/meetings/g/${encodeURIComponent(key)}`;
