// Workspace setup (ADR 0007): the workspace is a Better Auth organization; its domain and
// mailboxes go through the Worker's `/api/onboarding` routes, which ask the mail service.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, auth, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import { authCall, resetSession } from "./session.ts";
import type { Onboarding, OnboardingDomain, SetupStep } from "./types.ts";

/** Where setup stands: may this user create a workspace, and what the active one has so far. */
export const onboardingQuery = () =>
  queryOptions({
    queryKey: keys.onboarding(),
    queryFn: ({ signal }) => call(api.onboarding.$get(undefined, { init: { signal } })),
  });

/**
 * True when a workspace's setup is unfinished and this member can finish it (owners and admins).
 * Takes the session's member, the onboarding status's organization, or a switcher workspace.
 */
export function needsSetup(org: { role: string; setup: SetupStep } | null | undefined) {
  return !!org && (org.role === "owner" || org.role === "admin") && org.setup !== "complete";
}

/** Onboarding's pages, in order. */
export const ONBOARDING_PAGES = ["Workspace", "DNS", "Mailboxes", "Invite"] as const;

/**
 * The page a saved setup resumes on (an index into `ONBOARDING_PAGES`). A domain on its own
 * mail host resumes on the server page even once verified: its IMAP and SMTP servers are never
 * stored, so they are asked again before mailboxes.
 */
export function resumePage(data: Onboarding) {
  const step = data.organization?.setup ?? "created";
  const domain = data.domains[0];
  if (step === "mailboxes_created" || step === "invites_sent" || step === "complete") return 3;
  if (!domain) return 0;
  if (step === "dns_verified" && domain.provider !== "imap") return 2;
  return 1;
}

/** Lowercase letters and digits joined by dashes, plus a random tail so slugs never collide. */
function workspaceSlug(name: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${crypto.randomUUID().slice(0, 6)}`;
}

interface Reloadable {
  invalidate(): Promise<void>;
}

/**
 * Creates the workspace. Better Auth makes the creator its owner and switches the session to it,
 * so everything cached for the previous workspace is dropped (an identity change).
 */
export async function createWorkspace(client: QueryClient, router: Reloadable, name: string) {
  const organization = await authCall(
    auth.organization.create({ name: name.trim(), slug: workspaceSlug(name) }),
  );
  await resetSession(client, router);
  return organization;
}

/** Writes a domain's latest state into the cached onboarding status. */
function storeDomain(client: QueryClient, domain: OnboardingDomain) {
  client.setQueryData<Onboarding>(keys.onboarding(), (data) =>
    data?.organization
      ? { ...data, domains: [...data.domains.filter((d) => d.id !== domain.id), domain] }
      : data,
  );
}

/** `mutate(domain)`: claims it and returns the DNS records to add, each checked. */
export const addDomainMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (domain: string) => call(api.onboarding.domains.$post({ json: { domain } })),
    onSuccess: (domain) => storeDomain(client, domain),
  });

/** `mutate(domainId)`: checks the DNS records again. */
export const checkDomainMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.onboarding.domains[":id"].check.$post({ param: { id } })),
    onSuccess: (domain) => storeDomain(client, domain),
  });

export interface MailServer {
  host: string;
  port: number;
}

export interface NewMailbox {
  localPart: string;
  /** Only on a domain whose provider is `imap`: the mailbox's existing password. */
  password?: string;
}

/**
 * `mutate({ domainId, mailboxes, servers? })` creates each mailbox in turn and starts syncing it.
 * Safe to resubmit after a partial failure: a mailbox that exists is returned as is.
 */
export const createMailboxesMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: async (input: {
      domainId: string;
      mailboxes: NewMailbox[];
      servers?: { imap: MailServer; smtp: MailServer };
    }) => {
      const created = [];
      for (const mailbox of input.mailboxes) {
        created.push(
          await call(
            api.onboarding.mailboxes.$post({
              json: {
                domainId: input.domainId,
                localPart: mailbox.localPart,
                ...(input.servers && mailbox.password
                  ? { login: { password: mailbox.password, ...input.servers } }
                  : {}),
              },
            }),
          ),
        );
      }
      return created;
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.onboarding() }),
        client.invalidateQueries({ queryKey: keys.mailboxes() }),
      ]),
  });

/**
 * `mutate()` marks setup complete (the invite page's "Finish setup"), then reloads the session
 * and status so the route guards let the member into the inbox.
 */
export const finishSetupMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: () => call(api.onboarding.complete.$post()),
    onSuccess: () =>
      Promise.all([
        client.refetchQueries({ queryKey: keys.session() }),
        client.refetchQueries({ queryKey: keys.onboarding() }),
        client.invalidateQueries({ queryKey: keys.workspaces() }),
      ]),
  });
