import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export const useCreateMilestone = () => useMutation(createMilestoneMutation(useQueryClient()));
export const useUpdateMilestone = () => useMutation(updateMilestoneMutation(useQueryClient()));
export const useDeleteMilestone = () => useMutation(deleteMilestoneMutation(useQueryClient()));
export const useCreateDeliverable = () => useMutation(createDeliverableMutation(useQueryClient()));
export const useUpdateDeliverable = () => useMutation(updateDeliverableMutation(useQueryClient()));
export const useDeleteDeliverable = () => useMutation(deleteDeliverableMutation(useQueryClient()));
export const useGrantAccess = () => useMutation(grantAccessMutation(useQueryClient()));
export const useRevokeAccess = () => useMutation(revokeAccessMutation(useQueryClient()));
