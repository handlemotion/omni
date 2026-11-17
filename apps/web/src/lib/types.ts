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
  WorkspaceMember,
  Workspaces,
} from "@omni/client";

type ThreadListQuery = InferRequestType<Api["threads"]["$get"]>["query"];

/** Triage lane filter. `unsure` is AI triage below the auto-file confidence. */
export type Lane = NonNullable<ThreadListQuery["lane"]>;
/**
 * Which threads a list shows: `inbox` (not done, not in Later), `later`, `done`, `archive`, or
 * `all` (ADR 0007, ADR 0027). Not `queue`: the API still takes Later's old name from old tabs.
 */
export type ThreadView = Exclude<NonNullable<ThreadListQuery["view"]>, "queue">;

export const LANES = [
  "needs_reply",
  "waiting_on_them",
  "fyi",
  "noise",
  "unsure",
] as const satisfies readonly Lane[];

type NoneMissing<Missing extends never> = Missing;
export type LanesListed = NoneMissing<Exclude<Lane, (typeof LANES)[number]>>;

/** What a thread list shows. Absent `mailbox` means every mailbox the member can see. */
export interface ThreadFilter {
  view: ThreadView;
  mailbox?: string | undefined;
  lane?: Lane | undefined;
}

type ConversationListQuery = InferRequestType<Api["conversations"]["$get"]>["query"];

/**
 * A shared inbox's helpdesk views (ADR 0021), in navigation order. `mine` is open or pending
 * and assigned to you; `sla_at_risk` is open with a due time near or past, soonest first; `all`
 * is every conversation (for a tag on its own).
 */
export type HelpdeskView = NonNullable<ConversationListQuery["view"]>;
export const HELPDESK_VIEWS = [
  "unassigned",
  "mine",
  "open",
  "pending",
  "snoozed",
  "resolved",
  "sla_at_risk",
  "all",
] as const satisfies readonly HelpdeskView[];
export type HelpdeskViewsListed = NoneMissing<
  Exclude<HelpdeskView, (typeof HELPDESK_VIEWS)[number]>
>;

/** What a helpdesk list shows: one shared inbox's view, optionally one tag. */
export interface ConversationFilter {
  mailbox: string;
  view: HelpdeskView;
  tag?: string | undefined;
}

export type ConversationPage = InferResponseType<Api["conversations"]["$get"], 200>;
/** A row of a helpdesk list: a thread list row plus its tags and SLA due time. */
export type ConversationSummary = ConversationPage["conversations"][number];
/** Per shared inbox: `views` counts (not `resolved`) and open or pending ones per tag. */
export type ConversationCounts = InferResponseType<
  Api["conversations"]["counts"]["$get"],
  200
>["counts"];

/** A helpdesk conversation: status, assignee, priority, due times, tags and timeline events. */
export type Conversation = InferResponseType<Api["threads"][":id"]["conversation"]["$get"], 200>;
export type ConversationStatus = Conversation["status"];
export type Priority = Conversation["priority"];
export type ConversationEvent = Conversation["events"][number];
/** An internal note in a conversation's timeline. */
export type Note = Conversation["notes"][number];
export type NotificationPage = InferResponseType<Api["notifications"]["$get"], 200>;
/** One notification: `kind` (assigned, mention, customer_reply, …), the thread, its subject. */
export type Notification = NotificationPage["notifications"][number];
export type Tag = InferResponseType<Api["mailboxes"][":id"]["tags"]["$get"], 200>["tags"][number];
export type Assignee = InferResponseType<
  Api["mailboxes"][":id"]["assignees"]["$get"],
  200
>["assignees"][number];
/**
 * A shared inbox's SLA settings: `policies` (targets in minutes per priority, null untracked),
 * `businessHours` (null: always open) and whether it auto-assigns new conversations.
 */
export type Forwarding = InferResponseType<Api["forwarding"]["$get"], 200>["mailboxes"][number];
export type ForwardScope = Forwarding["scope"];
export type SlaSettings = InferResponseType<Api["mailboxes"][":id"]["sla"]["$get"], 200>;
export type SlaPolicy = SlaSettings["policies"][number];
/** What `PUT /mailboxes/:id/sla/:priority` takes: the three targets and `businessHoursOnly`. */
export type SlaTargets = InferRequestType<
  Api["mailboxes"][":id"]["sla"][":priority"]["$put"]
>["json"];
/** What `PUT /mailboxes/:id/business-hours` takes: `timezone`, weekly `windows`, `holidays`. */
export type BusinessHoursInput = InferRequestType<
  Api["mailboxes"][":id"]["business-hours"]["$put"]
>["json"];
/** Per conversation of a bulk change, in order: `ok` and `changed`, or `error`. */
export type BulkResult = InferResponseType<
  Api["conversations"]["bulk"]["$post"],
  200
>["results"][number];
