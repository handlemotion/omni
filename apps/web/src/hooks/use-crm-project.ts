import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { pendingId } from "@/lib/crm-pending.ts";
import {
  createDeliverableMutation,
  createMilestoneMutation,
  crmAccessQuery,
  crmPlanQuery,
  deleteDeliverableMutation,
  deleteMilestoneMutation,
  grantAccessMutation,
  revokeAccessMutation,
  updateDeliverableMutation,
  updateMilestoneMutation,
} from "@/lib/crm-project.ts";

export const useCrmPlan = (dealId: string) => useQuery(crmPlanQuery(dealId));
export const useProjectAccess = (dealId: string) => useQuery(crmAccessQuery(dealId));

function useAddAtOnce<V extends { pendingId: string }, T, E, C>(
  mutation: UseMutationResult<T, E, V, C>,
) {
  const { mutateAsync } = mutation;
  const create = useCallback(
    (input: Omit<V, "pendingId">, onError?: (error: unknown) => void) => {
      const id = pendingId();
      mutateAsync({ ...input, pendingId: id } as V).catch((error: unknown) => onError?.(error));
      return id;
    },
    [mutateAsync],
  );
  return { ...mutation, create };
}

export const useCreateMilestone = () =>
  useAddAtOnce(useMutation(createMilestoneMutation(useQueryClient())));
export const useUpdateMilestone = () => useMutation(updateMilestoneMutation(useQueryClient()));
export const useDeleteMilestone = () => useMutation(deleteMilestoneMutation(useQueryClient()));
export const useCreateDeliverable = () =>
  useAddAtOnce(useMutation(createDeliverableMutation(useQueryClient())));
export const useUpdateDeliverable = () => useMutation(updateDeliverableMutation(useQueryClient()));
export const useDeleteDeliverable = () => useMutation(deleteDeliverableMutation(useQueryClient()));
export const useGrantAccess = () => useMutation(grantAccessMutation(useQueryClient()));
export const useRevokeAccess = () => useMutation(revokeAccessMutation(useQueryClient()));
