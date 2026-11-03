// Names the app uses for API shapes. Every type comes from the Worker's routes through
// `@omni/client`; nothing here redefines a response by hand.
import type { Api } from "@omni/client";
import type { InferRequestType } from "hono/client";

export type {
  DnsRecord,
  Mailbox,
  Member,
  Onboarding,
  OnboardingDomain,
  Message,
  SearchResult,
  Thread,
  ThreadPage,
  ThreadSummary,
  RealtimeEvent,
  RealtimeStatus,
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

export const THREAD_VIEWS = [
  "inbox",
  "queue",
  "done",
  "archive",
  "all",
] as const satisfies readonly ThreadView[];

/** What a thread list shows. Absent `mailbox` means every mailbox the member can see. */
export interface ThreadFilter {
  view: ThreadView;
  mailbox?: string | undefined;
  lane?: Lane | undefined;
}
