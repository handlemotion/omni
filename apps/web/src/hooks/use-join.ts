// Join requests (ADR 0024): asking to join the company a sign-in is scoped to, and its owners'
// and admins' answers.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  answerJoinRequestMutation,
  askToJoinMutation,
  joinQuery,
  joinRequestsQuery,
} from "../lib/join.ts";

/**
 * The company this sign-in may ask to join, and whether it asked. Rechecked every 15s while
 * waiting, so an accepted request is noticed (the query then fails: there is nothing to join).
 */
export function useJoin() {
  return useQuery({ ...joinQuery(), refetchInterval: 15_000, retry: false });
}

/** `mutate()` asks to join; asking again changes nothing. */
export function useAskToJoin() {
  return useMutation(askToJoinMutation(useQueryClient()));
}

/** The requests waiting in the active workspace; only fetched for owners and admins. */
export function useJoinRequests(enabled: boolean) {
  return useQuery(joinRequestsQuery(enabled));
}

/** `mutate({ id, answer })` accepts (a new member) or declines a request. */
export function useAnswerJoinRequest() {
  return useMutation(answerJoinRequestMutation(useQueryClient()));
}
