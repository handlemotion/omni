// Workspace setup: the onboarding status, creating the workspace, its domain and its mailboxes.
// Inviting people is `useInviteMember` (use-organization.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  addDomainMutation,
  checkDomainMutation,
  createMailboxesMutation,
  createWorkspace,
  onboardingQuery,
} from "../lib/onboarding.ts";

/** `{ canCreateOrganization, organization, domains, mailboxes }`. */
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
