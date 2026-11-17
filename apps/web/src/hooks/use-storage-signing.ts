import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sendForSignatureMutation,
  signingCodeMutation,
  signingQuery,
  signMutation,
  storageSignaturesQuery,
  voidSignatureMutation,
} from "../lib/storage-signing.ts";

/** A file's signature requests, newest first (members who reach the file). */
export function useStorageSignatures(nodeId: string) {
  return useQuery(storageSignaturesQuery(nodeId));
}

export function useSendForSignature() {
  return useMutation(sendForSignatureMutation(useQueryClient()));
}

export function useVoidSignature() {
  return useMutation(voidSignatureMutation(useQueryClient()));
}

/** The request the signed-in person was asked to sign. */
export function useSigning(requestId: string) {
  return useQuery(signingQuery(requestId));
}

export function useSigningCode() {
  return useMutation(signingCodeMutation());
}

export function useSign() {
  return useMutation(signMutation(useQueryClient()));
}
