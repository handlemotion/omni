import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearForwardingMutation,
  forwardingQuery,
  setForwardingMutation,
} from "../lib/forwarding.ts";

export function useForwarding() {
  return useQuery(forwardingQuery());
}

export function useSetForwarding() {
  return useMutation(setForwardingMutation(useQueryClient()));
}

export function useClearForwarding() {
  return useMutation(clearForwardingMutation(useQueryClient()));
}
