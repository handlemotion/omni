import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { dropCrmEntity, optimisticCrm, setCrmFields, settleCrm } from "./crm-cache.ts";
import { currentId, pendingFailed, pendingMade, settledId } from "./crm-pending.ts";
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

const settle = (client: QueryClient) => settleCrm(client);

const changesAtOnce = (client: QueryClient) =>
  optimisticCrm(
    client,
    ({ id, position: _position, ...fields }: { id: string; position?: number }) =>
      setCrmFields(client, currentId(id), fields),
  );

const goneAtOnce = (client: QueryClient) =>
  optimisticCrm(client, (id: string) => dropCrmEntity(client, currentId(id)));

type PlanList = "milestones" | "deliverables";

function withItem<T extends { id: string }>(
  client: QueryClient,
  dealId: string,
  list: PlanList,
  item: T,
  replacing?: string,
) {
  client.setQueryData<CrmPlan>(keys.crmPlan(dealId), (plan) => {
    if (!plan) return plan;
    const items = plan[list] as unknown as T[];
    const at = items.findIndex((each) => each.id === (replacing ?? item.id));
    const next = at === -1 ? [...items, item] : items.with(at, item);
    return { ...plan, [list]: next };
  });
}

function addedAtOnce<V extends { dealId: string; pendingId: string }, T extends { id: string }>(
  client: QueryClient,
  list: PlanList,
  draft: (input: V, at: string) => T,
) {
  return {
    onMutate: async (input: V) => {
      await client.cancelQueries({ queryKey: keys.crmPlan(input.dealId) });
      withItem(client, input.dealId, list, draft(input, new Date().toISOString()));
    },
    onError: (error: unknown, input: V) => {
      pendingFailed(input.pendingId, error);
      dropCrmEntity(client, input.pendingId);
    },
    made: (item: T, input: V) => {
      pendingMade(input.pendingId, item.id);
      withItem(client, input.dealId, list, item, input.pendingId);
    },
  };
}

export type PendingMilestone = NewMilestone & { dealId: string; pendingId: string };
export type PendingDeliverable = NewDeliverable & { dealId: string; pendingId: string };

/** `mutate({ dealId, pendingId, ...milestone })`: it shows last on the plan at once. */
export const createMilestoneMutation = (client: QueryClient) => {
  const added = addedAtOnce<PendingMilestone, CrmMilestone>(client, "milestones", (input, at) => ({
    id: input.pendingId,
    dealId: input.dealId,
    title: input.title,
    description: input.description ?? null,
    targetOn: input.targetOn ?? null,
    status: input.status ?? "planned",
    position: client.getQueryData<CrmPlan>(keys.crmPlan(input.dealId))?.milestones.length ?? 0,
    completedAt: input.status === "done" ? at : null,
    createdByMemberId: null,
    createdAt: at,
    updatedAt: at,
  }));
  return mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ dealId, pendingId: _pending, ...json }: PendingMilestone) =>
      call(api.crm.deals[":id"].milestones.$post({ param: { id: dealId }, json })),
    onMutate: added.onMutate,
    onError: added.onError,
    onSuccess: ({ milestone }, input) => added.made(milestone, input),
    ...settle(client),
  });
};

export const updateMilestoneMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async ({ id, ...json }: MilestoneChange & { id: string }) =>
      call(api.crm.milestones[":id"].$patch({ param: { id: await settledId(id) }, json })),
    ...changesAtOnce(client),
    ...settle(client),
  });

export const deleteMilestoneMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (id: string) =>
      call(api.crm.milestones[":id"].$delete({ param: { id: await settledId(id) } })),
    ...goneAtOnce(client),
    ...settle(client),
  });

/** `mutate({ dealId, pendingId, ...deliverable })`: it shows last on the plan at once. */
export const createDeliverableMutation = (client: QueryClient) => {
  const added = addedAtOnce<PendingDeliverable, CrmDeliverable>(
    client,
    "deliverables",
    (input, at) => ({
      id: input.pendingId,
      dealId: input.dealId,
      milestoneId: input.milestoneId ?? null,
      title: input.title,
      description: input.description ?? null,
      nodeId: input.nodeId ?? null,
      dueOn: input.dueOn ?? null,
      status: input.status ?? "draft",
      clientVisible: input.clientVisible ?? false,
      reviewNote: null,
      reviewedAt: null,
      reviewedByEmail: null,
      createdByMemberId: null,
      createdAt: at,
      updatedAt: at,
    }),
  );
  return mutationOptions({
    meta: { handlesError: true },
    mutationFn: async ({ dealId, pendingId: _pending, ...json }: PendingDeliverable) => {
      const milestoneId = json.milestoneId ? await settledId(json.milestoneId) : json.milestoneId;
      return call(
        api.crm.deals[":id"].deliverables.$post({
          param: { id: dealId },
          json: { ...json, ...(milestoneId === undefined ? {} : { milestoneId }) },
        }),
      );
    },
    onMutate: added.onMutate,
    onError: added.onError,
    onSuccess: ({ deliverable }, input) => added.made(deliverable, input),
    ...settle(client),
  });
};

export const updateDeliverableMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async ({ id, ...json }: DeliverableChange & { id: string }) => {
      const milestoneId = json.milestoneId ? await settledId(json.milestoneId) : json.milestoneId;
      return call(
        api.crm.deliverables[":id"].$patch({
          param: { id: await settledId(id) },
          json: { ...json, ...(milestoneId === undefined ? {} : { milestoneId }) },
        }),
      );
    },
    ...changesAtOnce(client),
    ...settle(client),
  });

export const deleteDeliverableMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (id: string) =>
      call(api.crm.deliverables[":id"].$delete({ param: { id: await settledId(id) } })),
    ...goneAtOnce(client),
    ...settle(client),
  });

type AccessList = { access: CrmProjectAccess[] };

function accessAtOnce(
  client: QueryClient,
  dealId: string,
  change: (access: CrmProjectAccess[]) => CrmProjectAccess[],
) {
  client.setQueryData<AccessList>(
    keys.crmAccess(dealId),
    (data) => data && { ...data, access: change(data.access) },
  );
}

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `mutate({ dealId, email, scope })`: adds someone, or changes their scope, at once. */
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
    ...optimisticCrm(
      client,
      ({ dealId, email, scope }: { dealId: string; email: string; scope: CrmProjectScope }) =>
        accessAtOnce(client, dealId, (access) =>
          access.some((row) => sameEmail(row.email, email))
            ? access.map((row) => (sameEmail(row.email, email) ? { ...row, scope } : row))
            : [
                ...access,
                {
                  email,
                  scope,
                  name: null,
                  addedByMemberId: null,
                  createdAt: new Date().toISOString(),
                },
              ],
        ),
    ),
    ...settle(client),
  });

/** `mutate({ dealId, email })`: they leave the project's list at once. */
export const revokeAccessMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (input: { dealId: string; email: string }) =>
      call(
        api.crm.deals[":id"].access[":email"].$delete({
          param: { id: input.dealId, email: input.email },
        }),
      ),
    ...optimisticCrm(client, ({ dealId, email }: { dealId: string; email: string }) =>
      accessAtOnce(client, dealId, (access) =>
        access.filter((row) => !sameEmail(row.email, email)),
      ),
    ),
    ...settle(client),
  });
