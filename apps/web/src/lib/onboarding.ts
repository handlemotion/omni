// Workspace setup (ADR 0007): the workspace is a Better Auth organization; its domain and
// mailboxes go through the Worker's `/api/onboarding` routes, which ask the mail service.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, auth, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import { authCall, resetSession } from "./session.ts";
import type { Onboarding, OnboardingDomain, SetupStep, Workspace } from "./types.ts";

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

/**
 * Where onboarding's way out leads, so nobody is stuck in setup: the inbox when the active
 * workspace is ready (you came to make another), else another workspace that is ready (switch to
 * it), else signing out (no workspace to go to yet).
 */
export type OnboardingExit =
  | { kind: "inbox" }
  | { kind: "workspace"; workspace: Workspace }
  | { kind: "sign-out" };

export function onboardingExit(
  status: Onboarding | undefined,
  workspaces: readonly Workspace[] | undefined,
): OnboardingExit {
  const active = status?.organization;
  if (active && !needsSetup(active)) return { kind: "inbox" };
  const ready = workspaces?.find((w) => w.id !== active?.id && !needsSetup(w));
  return ready ? { kind: "workspace", workspace: ready } : { kind: "sign-out" };
}

/** Every onboarding page, in order. `Plan` appears only where billing is on (ADR 0015). */
export type OnboardingPage = "Workspace" | "DNS" | "Mailboxes" | "Plan" | "Invite";

/**
 * This deployment's pages. The plan comes after mailboxes, once the workspace works, and before
 * invitations, so nobody is invited into a workspace that has no plan yet.
 */
export function onboardingPages(data: Pick<Onboarding, "billing"> | undefined): OnboardingPage[] {
  return data?.billing.enabled
    ? ["Workspace", "DNS", "Mailboxes", "Plan", "Invite"]
    : ["Workspace", "DNS", "Mailboxes", "Invite"];
}

/**
 * The page a saved setup resumes on. Once mailboxes exist it is the plan while the workspace has
 * none (coming back from Stripe without paying included), else the invitations. A domain on its
 * own mail host resumes on the server page even once verified: its IMAP and SMTP servers are
 * never stored, so they are asked again before mailboxes.
 */
export function resumePage(data: Onboarding): OnboardingPage {
  const step = data.organization?.setup ?? "created";
  const domain = data.domains[0];
  if (step === "mailboxes_created" || step === "invites_sent" || step === "complete") {
    return data.billing.enabled && data.organization?.needsPlan ? "Plan" : "Invite";
  }
  if (!domain) return "Workspace";
  if (step === "dns_verified" && domain.provider !== "imap") return "Mailboxes";
  return "DNS";
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

const challengeKey = (domainId: string) => `omni.challenge.${domainId}`;

/**
 * The challenge value for a domain, if this browser saw it. The API shows it once (only its hash
 * is stored, ADR 0010), so it is kept here for a reload mid-setup. A convenience: without it the
 * DNS page offers a new value.
 */
export function rememberedChallenge(domain: OnboardingDomain): string | null {
  if (domain.challenge?.value) return domain.challenge.value;
  try {
    return localStorage.getItem(challengeKey(domain.id));
  } catch {
    return null;
  }
}

function rememberChallenge(domain: OnboardingDomain) {
  try {
    if (domain.challenge?.value)
      localStorage.setItem(challengeKey(domain.id), domain.challenge.value);
    // Verified: the record is in DNS already and the value no longer needed here.
    if (domain.status === "verified" && domain.challenge?.verified) {
      localStorage.removeItem(challengeKey(domain.id));
    }
  } catch {
    // Storage blocked (private window): the page still works, minus surviving a reload.
  }
}

/** Writes a domain's latest state into the cached onboarding status. */
function storeDomain(client: QueryClient, domain: OnboardingDomain) {
  rememberChallenge(domain);
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

/**
 * `mutate(domainId)`: removes the domain from the workspace (ADR 0016). A claim that never
 * verified is withdrawn; a verified domain is released (owners only, refused while it has
 * mailboxes). Its remembered challenge value goes with it.
 */
export const removeDomainMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) =>
      call(api.onboarding.domains[":id"].release.$post({ param: { id } })),
    onSuccess: (_, id) => {
      try {
        localStorage.removeItem(challengeKey(id));
      } catch {
        // Storage blocked: nothing was kept.
      }
      client.setQueryData<Onboarding>(keys.onboarding(), (data) =>
        data?.organization ? { ...data, domains: data.domains.filter((d) => d.id !== id) } : data,
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: keys.onboarding() }),
  });

/** `mutate(domainId)`: a new challenge value, for a member who lost the first one. */
export const rotateChallengeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) =>
      call(api.onboarding.domains[":id"].challenge.$post({ param: { id } })),
    onSuccess: (domain) => storeDomain(client, domain),
  });

/**
 * Keeps the domain checked while its DNS page is open (ADR 0011): results arrive over realtime.
 * `reset` restarts the quick checks (the page came back into focus).
 */
export function watchDomain(id: string, reset: boolean) {
  return call(api.onboarding.domains[":id"].watch.$post({ param: { id }, json: { reset } }));
}

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

/** A server as people type it, `host` or `host:port`; null when it isn't one. */
export function parseServer(value: string, defaultPort: number): MailServer | null {
  const match = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(value);
  if (!match) return null;
  return { host: match[1]!, port: match[2] ? Number(match[2]) : defaultPort };
}

export interface NewMailbox {
  localPart: string;
  /** Only on a domain whose provider is `imap`: the mailbox's existing password. */
  password?: string;
  /** A teammate whose personal inbox this is (settings); they own it, the creator doesn't. */
  forMemberId?: string;
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
                ...(mailbox.forMemberId ? { forMemberId: mailbox.forMemberId } : {}),
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
        client.invalidateQueries({ queryKey: keys.workspaceMailboxes() }),
        client.invalidateQueries({ queryKey: keys.workspaces() }),
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
