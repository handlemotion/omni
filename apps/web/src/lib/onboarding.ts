import { cancelUploads } from "./storage-uploads.ts";
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

export const onboardingExit: (
  status: Onboarding | undefined,
  workspaces: readonly Workspace[] | undefined,
) => OnboardingExit = (status, workspaces) => {
  const active = status?.organization;
  if (active && !needsSetup(active)) return { kind: "inbox" };
  const ready = workspaces?.find((w) => w.id !== active?.id && !needsSetup(w));
  return ready ? { kind: "workspace", workspace: ready } : { kind: "sign-out" };
};

/**
 * Every onboarding step, in one flat order that Back and Continue walk one step at a time: the
 * workspace's name, its domain (and where its mail stays: Google, or Omni), the domain's DNS
 * records, its inboxes (Google accounts, or mailboxes on the domain), teammates (skippable), and
 * the plan, only where billing is on (ADR 0015). A company's mail needs its domain first
 * (ADR 0024): an account lands where its address belongs. The plan comes last, so setup finishes
 * the moment it starts.
 */
export type OnboardingPage = "Workspace" | "Domain" | "Records" | "Inbox" | "Team" | "Plan";

/** What each step is called (the progress dots' label). */
export const PAGE_TITLES: Record<OnboardingPage, string> = {
  Workspace: "Create your workspace",
  Domain: "Your domain",
  Records: "DNS records",
  Inbox: "Inboxes",
  Team: "Invite your team",
  Plan: "Plan",
};

/** This setup's steps. */
export function onboardingPages(data: Pick<Onboarding, "billing"> | undefined) {
  return [
    "Workspace",
    "Domain",
    "Records",
    "Inbox",
    "Team",
    ...(data?.billing.enabled ? (["Plan"] as const) : []),
  ] satisfies OnboardingPage[];
}

/**
 * A record passes when the domain's own nameservers serve it. Their answer, when there is one,
 * wins over the provider's flag: Purelymail's stored verdict can say an SPF record is in place
 * while public DNS holds only the old one.
 */
export const recordPasses = (
  r: Pick<OnboardingDomain["records"][number], "verified" | "diagnostic">,
) => (r.diagnostic ? r.diagnostic.status === "ok" : r.verified);

/** Omni's ownership record and the provider's ownership records all pass. */
export function ownershipReady(domain: OnboardingDomain) {
  return (
    challengePasses(domain) &&
    domain.records.filter((r) => r.check === "ownership").every(recordPasses)
  );
}

/** The provider's mail records (MX, SPF, DKIM, DMARC) all pass. */
export function mailRecordsReady(domain: OnboardingDomain) {
  return domain.records.filter((r) => r.check !== "ownership").every(recordPasses);
}

/** Every record the domain's provider needs passes: it can take mail (or connect accounts). */
export const domainReady = (domain: OnboardingDomain) =>
  ownershipReady(domain) && mailRecordsReady(domain);

/** Whether a step is done, from what is saved, never from the page someone is on. */
export function pageDone(page: OnboardingPage, data: Onboarding | undefined) {
  const org = data?.organization;
  switch (page) {
    case "Workspace":
      return !!org;
    case "Domain":
      return !!data?.domains.length;
    case "Records":
      return !!data?.domains.some(domainReady);
    case "Inbox":
      return !!data?.mailboxes.length;
    case "Team":
      return (
        org?.setup === "invites_sent" ||
        org?.setup === "complete" ||
        (!!data?.billing.enabled && !!org && !org.needsPlan)
      );
    case "Plan":
      return !!org && !org.needsPlan;
  }
}

/** Where setup resumes: the first step that is not done. */
export function resumePage(data: Onboarding) {
  const pages = onboardingPages(data);
  return (pages.find((p) => !pageDone(p, data)) ?? pages.at(-1) ?? "Team") satisfies OnboardingPage;
}

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
  await cancelUploads();
  const organization = await authCall(
    auth.organization.create({ name: name.trim(), slug: workspaceSlug(name) }),
  );
  await resetSession(client, router);
  return organization;
}

const challengeKey = (domainId: string) => `omni.challenge.${domainId}`;

/**
 * Whether Omni's ownership record is in DNS with the current value. What the domain's nameservers
 * answered at the last check wins over the claim's flag: right after a new value is made the claim
 * still reads verified, but DNS holds the old value until it is replaced.
 */
export function challengePasses(domain: OnboardingDomain) {
  const challenge = domain.challenge;
  if (!challenge) return true;
  return challenge.diagnostic ? challenge.diagnostic.status === "ok" : challenge.verified;
}

/**
 * The challenge value for a domain, if this browser saw it. The API shows it once (only its hash
 * is stored, ADR 0010), so it is kept here for a reload mid-setup. A convenience: without it the
 * DNS page offers a new value.
 */
export function rememberedChallenge(domain: OnboardingDomain) {
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
    if (domain.challenge?.diagnostic?.status === "ok" && !domain.challenge.value) {
      localStorage.removeItem(challengeKey(domain.id));
    }
  } catch {}
}

function storeDomain(client: QueryClient, domain: OnboardingDomain) {
  rememberChallenge(domain);
  client.setQueryData<Onboarding>(keys.onboarding(), (data) =>
    data ? { ...data, domains: [...data.domains.filter((d) => d.id !== domain.id), domain] } : data,
  );
}

/** `mutate(domain)`: claims it and returns the DNS records to add, each checked. */
export const addDomainMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (input: string | { domain: string; host: "gmail" }) =>
      call(
        api.onboarding.domains.$post({
          json: typeof input === "string" ? { domain: input } : input,
        }),
      ),
    onSuccess: (domain) => storeDomain(client, domain),
  });

/**
 * `mutate(domainId)`: removes the domain from the workspace (ADR 0016). A claim that never
 * verified is withdrawn; a verified domain is released (owners only, refused while it has
 * mailboxes). Its remembered challenge value goes with it.
 */
export const removeDomainMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) =>
      call(api.onboarding.domains[":id"].release.$post({ param: { id } })),
    onSuccess: (_, id) => {
      try {
        localStorage.removeItem(challengeKey(id));
      } catch {}
      client.setQueryData<Onboarding>(keys.onboarding(), (data) =>
        data ? { ...data, domains: data.domains.filter((d) => d.id !== id) } : data,
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: keys.onboarding() }),
  });

/** `mutate(domainId)`: a new challenge value, for a member who lost the first one. */
export const rotateChallengeMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
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
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.onboarding.domains[":id"].check.$post({ param: { id } })),
    onSuccess: (domain) => storeDomain(client, domain),
  });

export interface MailServer {
  host: string;
  port: number;
}

/** A server as people type it, `host` or `host:port`; null when it isn't one. */
export const parseServer: (value: string, defaultPort: number) => MailServer | null = (
  value,
  defaultPort,
) => {
  const match = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(value);
  if (!match) return null;
  return { host: match[1]!, port: match[2] ? Number(match[2]) : defaultPort };
};

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
    meta: { handlesError: true },
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
        client.invalidateQueries({ queryKey: keys.workspaceMailboxes() }),
        client.invalidateQueries({ queryKey: keys.workspaces() }),
      ]),
  });

/**
 * `mutate()` marks setup complete (the last step's button), then reloads the session
 * and status so the route guards let the member into the inbox.
 */
export const finishSetupMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: () => call(api.onboarding.complete.$post()),
    onSuccess: () =>
      Promise.all([
        client.refetchQueries({ queryKey: keys.session() }),
        client.refetchQueries({ queryKey: keys.onboarding() }),
        client.invalidateQueries({ queryKey: keys.workspaces() }),
      ]),
  });
