// The addresses a person signs in with (ADR 0014): list, add (mails a link), confirm, make
// primary, remove.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addSignInEmailMutation,
  removeSignInEmailMutation,
  setPrimarySignInEmailMutation,
  signInEmailsQuery,
  verifySignInEmailMutation,
} from "../lib/sign-in-emails.ts";

export function useSignInEmails() {
  return useQuery(signInEmailsQuery());
}

/** `mutate(email)` mails a confirmation link to it. */
export function useAddSignInEmail() {
  return useMutation(addSignInEmailMutation());
}

/** `mutate(token)` confirms the address the link was sent to. */
export function useVerifySignInEmail() {
  return useMutation(verifySignInEmailMutation(useQueryClient()));
}

export function useSetPrimarySignInEmail() {
  return useMutation(setPrimarySignInEmailMutation(useQueryClient()));
}

export function useRemoveSignInEmail() {
  return useMutation(removeSignInEmailMutation(useQueryClient()));
}
