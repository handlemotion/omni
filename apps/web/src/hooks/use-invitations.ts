import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ApiError } from "../lib/api.ts";
import {
  chooseJustMe,
  invitationStatusQuery,
  pendingInvitationsQuery,
} from "../lib/invitations.ts";
import { keys } from "../lib/query-keys.ts";

/** Every pending invitation to any of the signed-in person's verified sign-in emails. */
export function usePendingInvitations() {
  return useQuery(pendingInvitationsQuery());
}

/**
 * The invitation a `/invite/<id>` link names, as the signed-in person may see it. `missing` is
 * true only when the Worker answered that there is no such invitation (404), not when the read
 * failed for another reason.
 */
export function useInvitationStatus(invitationId: string) {
  const query = useQuery(invitationStatusQuery(invitationId));
  const missing = query.error instanceof ApiError && query.error.status === 404;
  return { ...query, missing };
}

/** Reads the invitations again after one was answered, and reruns the route guards. */
export function useRefreshInvitations() {
  const client = useQueryClient();
  const router = useRouter();
  return async (invitationId?: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.pendingInvitations() }),
      invitationId && client.invalidateQueries({ queryKey: keys.invitationStatus(invitationId) }),
    ]);
    await router.invalidate();
  };
}

/** `mutate()` chooses "Just me": makes and opens the Personal space. Resolves to its slug. */
export function useJustMe() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    meta: { handlesError: true },
    mutationFn: () => chooseJustMe(client, router),
  });
}
