import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

type Portal = Api["portal"];

export type PortalProject = InferResponseType<Portal["projects"]["$get"], 200>["projects"][number];
export type PortalDetail = InferResponseType<Portal["projects"][":id"]["$get"], 200>;
export type PortalDeliverable = PortalDetail["deliverables"][number];
export type PortalContract = PortalDetail["contracts"][number];
export type PortalFile = NonNullable<PortalDetail["folder"]>["files"][number];

export const portalProjectsQuery = () =>
  queryOptions({
    queryKey: keys.portalProjects(),
    queryFn: ({ signal }) => call(api.portal.projects.$get(undefined, { init: { signal } })),
    select: (data) => data.projects,
  });

export const portalProjectQuery = (id: string) =>
  queryOptions({
    queryKey: keys.portalProject(id),
    queryFn: ({ signal }) =>
      call(api.portal.projects[":id"].$get({ param: { id } }, { init: { signal } })),
  });

/** `mutate({ projectId, deliverableId, decision, note })`: the answer replaces the project. */
export const reviewMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (input: {
      projectId: string;
      deliverableId: string;
      decision: "approve" | "request_changes";
      note?: string;
    }) =>
      call(
        api.portal.projects[":id"].deliverables[":deliverableId"].review.$post({
          param: { id: input.projectId, deliverableId: input.deliverableId },
          json: { decision: input.decision, note: input.note ?? null },
        }),
      ),
    onSuccess: (detail, input) => client.setQueryData(keys.portalProject(input.projectId), detail),
  });
