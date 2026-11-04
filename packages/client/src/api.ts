import type { AppType } from "@omni/worker";
import { hc, type ClientRequestOptions, type InferResponseType } from "hono/client";

export interface ApiOptions {
  /** The Worker's origin, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** Headers for every request. On iOS, the session cookie from the auth client. */
  headers?: ClientRequestOptions["headers"];
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

const typedHc = (...args: Parameters<typeof hc>) => hc<AppType>(...args);

/** The whole Worker, typed from its routes: `client.api.threads.$get({ query: {} })`. */
export type Client = ReturnType<typeof typedHc>;
/** The member-facing routes under `/api`. */
export type Api = Client["api"];

/**
 * Typed calls to `/api`. The web app sends the session cookie itself (`credentials: "include"`,
 * which a cross-origin API needs); iOS passes it in `headers`. Mutating routes require an
 * `idempotency-key` header: reuse the same key when retrying the same intent.
 */
export function createApi(options: ApiOptions): Api {
  return typedHc(options.baseUrl, {
    headers: options.headers,
    fetch: options.fetch,
    init: { credentials: "include" },
  }).api;
}

export type Member = InferResponseType<Api["me"]["$get"], 200>;
export type Mailbox = InferResponseType<Api["mailboxes"]["$get"], 200>["mailboxes"][number];
export type ThreadPage = InferResponseType<Api["threads"]["$get"], 200>;
export type ThreadSummary = ThreadPage["threads"][number];
export type Thread = InferResponseType<Api["threads"][":id"]["$get"], 200>;
export type Message = Thread["messages"][number];
export type SearchResult = InferResponseType<Api["search"]["$get"], 200>["results"][number];
/** Where workspace setup stands (`GET /api/onboarding`). */
export type Onboarding = InferResponseType<Api["onboarding"]["$get"], 200>;
/** A domain being set up, with its DNS records and their last check. */
export type OnboardingDomain = InferResponseType<Api["onboarding"]["domains"]["$post"], 200>;
export type DnsRecord = OnboardingDomain["records"][number];
/** Every workspace the user belongs to, for the switcher (`GET /api/workspaces`). */
export type Workspaces = InferResponseType<Api["workspaces"]["$get"], 200>;
export type Workspace = Workspaces["workspaces"][number];
export type WorkspaceMailbox = Workspace["mailboxes"][number];
/**
 * One mailbox of the active workspace as owners and admins see it (`GET /api/workspace/mailboxes`):
 * its health, a personal one's owner, a shared one's head count. No mail.
 */
export type OrgMailbox = InferResponseType<
  Api["workspace"]["mailboxes"]["$get"],
  200
>["mailboxes"][number];
/** `created → domain_added → dns_verified → mailboxes_created → invites_sent → complete`. */
export type SetupStep = Workspace["setup"];
