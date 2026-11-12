// Names the app uses for API shapes. Every type comes from the Worker's routes through
// `@omni/client`; nothing here redefines a response by hand.
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";

export type {
  DnsRecord,
  Mailbox,
  Member,
  Onboarding,
  OnboardingDomain,
  OrgMailbox,
  Message,
  SearchResult,
  Thread,
  ThreadPage,
  ThreadSummary,
  RealtimeEvent,
  RealtimeStatus,
  SetupStep,
  Workspace,
  WorkspaceMailbox,
  Workspaces,
} from "@omni/client";

type ThreadListQuery = InferRequestType<Api["threads"]["$get"]>["query"];

/** Triage lane filter. `unsure` is AI triage below the auto-file confidence. */
export type Lane = NonNullable<ThreadListQuery["lane"]>;
/**
 * Which threads a list shows: `inbox` (not done, not deferred), `queue` (deferred), `done`,
 * `archive`, or `all` (ADR 0007).
 */
export type ThreadView = NonNullable<ThreadListQuery["view"]>;

export const LANES = [
  "needs_reply",
  "waiting_on_them",
  "fyi",
  "noise",
  "unsure",
] as const satisfies readonly Lane[];

// Fails to compile when the API gains a lane that `LANES` leaves out (`?lane=` would ignore it).
type NoneMissing<Missing extends never> = Missing;
export type LanesListed = NoneMissing<Exclude<Lane, (typeof LANES)[number]>>;

/** What a thread list shows. Absent `mailbox` means every mailbox the member can see. */
export interface ThreadFilter {
  view: ThreadView;
  mailbox?: string | undefined;
  lane?: Lane | undefined;
}

/**
 * A shared inbox's helpdesk views (ADR 0021), in navigation order. `mine` is assigned to you;
 * `sla_at_risk` is open with a due time near or past.
 */
export const HELPDESK_VIEWS = [
  "unassigned",
  "mine",
  "open",
  "pending",
  "snoozed",
  "resolved",
  "sla_at_risk",
] as const;
export type HelpdeskView = (typeof HELPDESK_VIEWS)[number];

/** A helpdesk conversation: status, assignee, priority, due times, tags and timeline events. */
export type Conversation = InferResponseType<Api["threads"][":id"]["conversation"]["$get"], 200>;
export type ConversationStatus = Conversation["status"];
export type Priority = Conversation["priority"];
export type ConversationEvent = Conversation["events"][number];
export type Tag = InferResponseType<Api["mailboxes"][":id"]["tags"]["$get"], 200>["tags"][number];
export type Assignee = InferResponseType<
  Api["mailboxes"][":id"]["assignees"]["$get"],
  200
>["assignees"][number];
