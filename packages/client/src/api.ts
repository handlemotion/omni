import { ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION } from "@omni/contracts/errors";
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

/** The whole Worker, typed from its routes: `client.api.threads.$get({ query: {} })`. */
export type Client = ReturnType<typeof hc<AppType>>;

// WARNING: keep these typed by name; the inferred route tree is too large for tsc to emit.
const typedHc: (...args: Parameters<typeof hc>) => Client = (...args) => hc<AppType>(...args);

/** The member-facing routes under `/api`. */
export type Api = Client["api"];

/**
 * Typed calls to `/api`. The web app sends the session cookie itself (`credentials: "include"`,
 * which a cross-origin API needs); iOS passes it in `headers`. Mutating routes require an
 * `idempotency-key` header: reuse the same key when retrying the same intent. Every call asks
 * for the nested error shape; read a failure with `toApiError`.
 */
export const createApi: (options: ApiOptions) => Api = (options) => {
  const { headers } = options;
  return typedHc(options.baseUrl, {
    headers: async () => ({
      [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION,
      ...(typeof headers === "function" ? await headers() : headers),
    }),
    fetch: options.fetch,
    init: { credentials: "include" },
  }).api;
};

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
/** The invitations waiting for the signed-in person (`GET /api/invitations`). */
export type PendingInvitations = InferResponseType<Api["invitations"]["$get"], 200>;
export type PendingInvitation = PendingInvitations["invitations"][number];
/** One invitation as its link shows it (`GET /api/invitations/:id`). */
export type InvitationStatus = InferResponseType<Api["invitations"][":id"]["$get"], 200>;
export type Workspace = Workspaces["workspaces"][number];
export type WorkspaceMailbox = Workspace["mailboxes"][number];
/**
 * One mailbox of the active workspace as owners and admins see it (`GET /api/workspace/inboxes`):
 * its health, a personal one's owner, a shared one's head count, and `orphaned` when its owner
 * left. No mail.
 */
export type OrgMailbox = InferResponseType<
  Api["workspace"]["inboxes"]["$get"],
  200
>["inboxes"][number];
/** A member of the active workspace with the inboxes they can open (`GET /api/workspace/members`). */
export type WorkspaceMember = InferResponseType<
  Api["workspace"]["members"]["$get"],
  200
>["members"][number];
/** `created → domain_added → dns_verified → mailboxes_created → invites_sent → complete`. */
export type SetupStep = Workspace["setup"];
