// The workspace's AI settings (ADR 0033), for owners and admins.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiSettingsQuery, setRoleMutation, setTagDescriptionMutation } from "../lib/ai-settings.ts";

export function useAiSettings() {
  return useQuery(aiSettingsQuery());
}

export function useSetRole() {
  return useMutation(setRoleMutation(useQueryClient()));
}

export function useSetTagDescription() {
  return useMutation(setTagDescriptionMutation(useQueryClient()));
}
