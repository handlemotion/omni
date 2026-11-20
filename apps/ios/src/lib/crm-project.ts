import type { Api } from "@omni/client";
import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

type Crm = Api["crm"];
export type CrmPlan = InferResponseType<Crm["deals"][":id"]["plan"]["$get"], 200>;
export type CrmMilestone = CrmPlan["milestones"][number];
export type CrmDeliverable = CrmPlan["deliverables"][number];
export type CrmProjectAccess = InferResponseType<
  Crm["deals"][":id"]["access"]["$get"],
  200
>["access"][number];

const MILESTONE_STATUS: Record<CrmMilestone["status"], string> = {
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
};

const DELIVERABLE_STATUS: Record<CrmDeliverable["status"], string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  changes_requested: "Changes requested",
};

/** A milestone's or deliverable's status, as the web app labels it. */
export const milestoneStatus = (milestone: CrmMilestone) => MILESTONE_STATUS[milestone.status];
export const deliverableStatus = (deliverable: CrmDeliverable) =>
  DELIVERABLE_STATUS[deliverable.status];

/** A project's milestones (in order) and deliverables. */
export const usePlan = (dealId: string) =>
  useQuery({
    queryKey: keys.crmPlan(dealId),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].plan.$get({ param: { id: dealId } }, { init: { signal } })),
  });

/** The people outside the team on a project, with their scope. */
export const useProjectAccess = (dealId: string) =>
  useQuery({
    queryKey: keys.crmAccess(dealId),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].access.$get({ param: { id: dealId } }, { init: { signal } })),
    select: (data) => data.access,
  });
