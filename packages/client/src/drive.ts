import type {
  STORAGE_THUMBNAIL_MAX_SOURCE_BYTES as WorkerThumbnailMax,
  StorageGrantRole,
  StorageLinkAccess,
} from "@omni/contracts";

/**
 * The largest original the Worker draws a thumbnail from (20 MB). Typed as the contract's own
 * value so the two can't drift, without pulling its schemas in.
 */
export const STORAGE_THUMBNAIL_MAX_SOURCE_BYTES: typeof WorkerThumbnailMax = 20_000_000;

export const DRIVE_ROLES: { id: StorageGrantRole; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "commenter", label: "Commenter" },
  { id: "editor", label: "Editor" },
];

export const DRIVE_LINK_ACCESS: { id: StorageLinkAccess; label: string }[] = [
  { id: "restricted", label: "Restricted" },
  { id: "workspace", label: "People in this workspace" },
  { id: "anyone", label: "Anyone with the link" },
];

export const driveRoleLabel = (role: StorageGrantRole) =>
  DRIVE_ROLES.find((r) => r.id === role)?.label ?? role;

export const linkAccessLabel = (access: StorageLinkAccess) =>
  DRIVE_LINK_ACCESS.find((a) => a.id === access)?.label ?? access;
