import { useMutation, useQueryClient } from "@tanstack/react-query";
import { labelMailboxMutation, senderNameMutation } from "../lib/mailbox-label.ts";
import { useWorkspaces } from "./use-workspaces.ts";

/** Every mailbox you can open, in all your workspaces, with its label and picture. */
export function useYourMailboxes() {
  return useWorkspaces().data?.workspaces.flatMap((workspace) => workspace.mailboxes) ?? [];
}

/** One of your mailboxes by id or address; undefined while loading or when it isn't yours. */
export function useYourMailbox(key: { id?: string; address?: string }) {
  const address = key.address?.toLowerCase();
  return useYourMailboxes().find(
    (box) => (key.id && box.id === key.id) || (address && box.address.toLowerCase() === address),
  );
}

export function useLabelMailbox() {
  return useMutation(labelMailboxMutation(useQueryClient()));
}

export function useSenderName() {
  return useMutation(senderNameMutation(useQueryClient()));
}
