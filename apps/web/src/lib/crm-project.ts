import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { crmChanged } from "./crm.ts";
import { keys } from "./query-keys.ts";

type Crm = Api["crm"];
type Json<T> = T extends { json: infer J } ? J : never;

export type CrmPlan = InferResponseType<Crm["deals"][":id"]["plan"]["$get"], 200>;
export type CrmMilestone = CrmPlan["milestones"][number];
export type CrmDeliverable = CrmPlan["deliverables"][number];
export type CrmMilestoneStatus = CrmMilestone["status"];
export type CrmDeliverableStatus = CrmDeliverable["status"];
export type MilestoneChange = Json<InferRequestType<Crm["milestones"][":id"]["$patch"]>>;
export type NewMilestone = Json<InferRequestType<Crm["deals"][":id"]["milestones"]["$post"]>>;
export type DeliverableChange = Json<InferRequestType<Crm["deliverables"][":id"]["$patch"]>>;
export type NewDeliverable = Json<InferRequestType<Crm["deals"][":id"]["deliverables"]["$post"]>>;
export type CrmProjectAccess = InferResponseType<
  Crm["deals"][":id"]["access"]["$get"],
  200
>["access"][number];
export type CrmProjectScope = CrmProjectAccess["scope"];

export const MILESTONE_STATUSES: { id: CrmMilestoneStatus; label: string }[] = [
  { id: "planned", label: "Planned" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
];

export const DELIVERABLE_STATUSES: { id: CrmDeliverableStatus; label: string }[] = [
  { id: "draft", label: "Draft" },
  { id: "in_review", label: "In review" },
  { id: "approved", label: "Approved" },
  { id: "changes_requested", label: "Changes requested" },
];

export const PROJECT_SCOPES: { id: CrmProjectScope; label: string }[] = [
  { id: "freelancer", label: "Freelancer" },
  { id: "client", label: "Client" },
];

export const crmPlanQuery = (dealId: string) =>
  queryOptions({
    queryKey: keys.crmPlan(dealId),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].plan.$get({ param: { id: dealId } }, { init: { signal } })),
  });

export const crmAccessQuery = (dealId: string) =>
  queryOptions({
    queryKey: keys.crmAccess(dealId),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].access.$get({ param: { id: dealId } }, { init: { signal } })),
    select: (data) => data.access,
  });

const settle = (client: QueryClient) => ({ onSettled: () => crmChanged(client) });

export const createMilestoneMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ dealId, ...json }: NewMilestone & { dealId: string }) =>
      call(api.crm.deals[":id"].milestones.$post({ param: { id: dealId }, json })),
    ...settle(client),
  });

export const updateMilestoneMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: MilestoneChange & { id: string }) =>
      call(api.crm.milestones[":id"].$patch({ param: { id }, json })),
    ...settle(client),
  });

export const deleteMilestoneMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.milestones[":id"].$delete({ param: { id } })),
    ...settle(client),
  });

export const createDeliverableMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ dealId, ...json }: NewDeliverable & { dealId: string }) =>
      call(api.crm.deals[":id"].deliverables.$post({ param: { id: dealId }, json })),
    ...settle(client),
  });

export const updateDeliverableMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: DeliverableChange & { id: string }) =>
      call(api.crm.deliverables[":id"].$patch({ param: { id }, json })),
    ...settle(client),
  });

export const deleteDeliverableMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.deliverables[":id"].$delete({ param: { id } })),
    ...settle(client),
  });

/** `mutate({ dealId, email, scope })`: adds someone, or changes their scope. */
export const grantAccessMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (input: { dealId: string; email: string; scope: CrmProjectScope }) =>
      call(
        api.crm.deals[":id"].access[":email"].$put({
          param: { id: input.dealId, email: input.email },
          json: { scope: input.scope },
        }),
      ),
    ...settle(client),
  });

export const revokeAccessMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (input: { dealId: string; email: string }) =>
      call(
        api.crm.deals[":id"].access[":email"].$delete({
          param: { id: input.dealId, email: input.email },
        }),
      ),
    ...settle(client),
  });
