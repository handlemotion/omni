// Your profile picture and the active workspace's logo. Each change refetches the session,
// members and workspaces, so the new picture shows everywhere.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  removeProfilePictureMutation,
  removeWorkspaceLogoMutation,
  uploadProfilePictureMutation,
  uploadWorkspaceLogoMutation,
} from "../lib/pictures.ts";

/** `mutate(file)` sets your picture (PNG, JPEG, WebP or GIF, at most 2 MB); resolves `{ image }`. */
export function useUploadProfilePicture() {
  return useMutation(uploadProfilePictureMutation(useQueryClient()));
}

/** `mutate()` clears your picture; resolves `{ image: null }`. */
export function useRemoveProfilePicture() {
  return useMutation(removeProfilePictureMutation(useQueryClient()));
}

/** `mutate(file)` sets the active workspace's logo (owners and admins); resolves `{ logo }`. */
export function useUploadWorkspaceLogo() {
  return useMutation(uploadWorkspaceLogoMutation(useQueryClient()));
}

/** `mutate()` clears the active workspace's logo (owners and admins); resolves `{ logo: null }`. */
export function useRemoveWorkspaceLogo() {
  return useMutation(removeWorkspaceLogoMutation(useQueryClient()));
}
