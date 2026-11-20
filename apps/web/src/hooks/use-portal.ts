import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { portalProjectQuery, portalProjectsQuery, reviewMutation } from "@/lib/portal.ts";

export const usePortalProjects = () => useQuery(portalProjectsQuery());
export const usePortalProject = (id: string) => useQuery(portalProjectQuery(id));
export const useReviewDeliverable = () => useMutation(reviewMutation(useQueryClient()));
