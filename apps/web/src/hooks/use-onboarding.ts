// Workspace setup: the onboarding status, creating the workspace, its domain and its mailboxes.
// Inviting people is `useInviteMember` (use-organization.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  addDomainMutation,
  checkDomainMutation,
  createMailboxesMutation,
  createWorkspace,
  finishSetupMutation,
  onboardingExit,
  onboardingQuery,
} from "../lib/onboarding.ts";
import { signOut } from "../lib/session.ts";
import { openWorkspace, workspacesQuery } from "../lib/workspaces.ts";

/** `{ canCreateOrganization, organization: { id, name, role, setup } | null, domains, mailboxes }`. */
export function useOnboarding() {
  return useQuery(onboardingQuery());
}

/** `mutate(name)` creates the workspace, makes you its owner and switches to it. */
export function useCreateWorkspace() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({ mutationFn: (name: string) => createWorkspace(client, router, name) });
}

/** `mutate(domain)`: the domain with the DNS records to add (Purelymail) or none (own host). */
export function useAddDomain() {
  return useMutation(addDomainMutation(useQueryClient()));
}

/** `mutate(domainId)` re-checks every DNS record. */
export function useCheckDomain() {
  return useMutation(checkDomainMutation(useQueryClient()));
}

/** `mutate({ domainId, mailboxes, servers? })` creates the mailboxes and starts syncing them. */
export function useCreateMailboxes() {
  return useMutation(createMailboxesMutation(useQueryClient()));
}

/** `mutate()` finishes setup once a mailbox exists; then `/inbox` opens instead of onboarding. */
export function useFinishSetup() {
  return useMutation(finishSetupMutation(useQueryClient()));
}

/**
 * Onboarding's way back to the app: `{ exit, leave, isPending }`. `exit.kind` is `inbox` (the
 * active workspace is ready), `workspace` (switch to `exit.workspace`, which is ready) or
 * `sign-out` (no workspace to go to yet); `leave()` does it.
 */
export function useOnboardingExit() {
  const client = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const status = useOnboarding();
  const workspaces = useQuery(workspacesQuery());
  const exit = onboardingExit(status.data, workspaces.data?.workspaces);
  const leave = useMutation({
    mutationFn: async () => {
      if (exit.kind === "inbox") await navigate({ to: "/inbox" });
      else if (exit.kind === "workspace") await openWorkspace(client, router, exit.workspace);
      else await signOut(client, router);
    },
  });
  return { exit, leave: () => leave.mutate(), isPending: leave.isPending };
}
