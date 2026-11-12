// A shared inbox's SLA settings: targets per priority, business hours and auto-assign. Every
// change shows at once and rolls back if the request fails (403 for members who are not owners or
// admins). A conversation's own due times are on `useConversation(threadId).data`
// (`firstResponseDueAt`, `nextResponseDueAt`, `resolutionDueAt`), and list rows carry the soonest
// as `slaDueAt`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteBusinessHoursMutation,
  deleteSlaPolicyMutation,
  putBusinessHoursMutation,
  putSlaPolicyMutation,
  setAutoAssignMutation,
  slaSettingsQuery,
} from "../lib/sla.ts";

/**
 * `{ policies, businessHours, autoAssign }` for the inbox. `policies` lists only the priorities
 * with targets (`firstResponseMinutes`, `nextResponseMinutes`, `resolutionMinutes`, each null when
 * untracked, and `businessHoursOnly`); `businessHours` is null when the inbox is always open.
 */
export function useSlaSettings(mailboxId: string | undefined) {
  return useQuery({ ...slaSettingsQuery(mailboxId ?? ""), enabled: !!mailboxId });
}

/** `mutate({ mailboxId, priority, targets: { firstResponseMinutes, nextResponseMinutes, resolutionMinutes, businessHoursOnly? } })`. */
export function usePutSlaPolicy() {
  return useMutation(putSlaPolicyMutation(useQueryClient()));
}

/** `mutate({ mailboxId, priority })`: that priority is no longer tracked. */
export function useDeleteSlaPolicy() {
  return useMutation(deleteSlaPolicyMutation(useQueryClient()));
}

/**
 * `mutate({ mailboxId, hours: { timezone, windows: [{ day, start, end }], holidays? } })`. `day`
 * 0 is Sunday; `start`/`end` are "HH:MM" (end may be "24:00"); holidays are "YYYY-MM-DD". 400 on
 * an unknown time zone.
 */
export function usePutBusinessHours() {
  return useMutation(putBusinessHoursMutation(useQueryClient()));
}

/** `mutate({ mailboxId })`: the inbox is always open again. */
export function useDeleteBusinessHours() {
  return useMutation(deleteBusinessHoursMutation(useQueryClient()));
}

/** `mutate({ mailboxId, enabled })`: round-robin new customer conversations among the inbox's members. */
export function useSetAutoAssign() {
  return useMutation(setAutoAssignMutation(useQueryClient()));
}
