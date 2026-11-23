/**
 * The refusals Storage's operations share. Each operation answers its own result or one of
 * these, by a `status` the Worker turns into an error code.
 */
export type NotFound = { status: "not_found" };
/** Reachable, but the holder's role does not allow the change. */
export type Forbidden = { status: "forbidden" };
export type InvalidName = { status: "invalid_name" };
export type TooDeep = { status: "too_deep" };
/** A locked file, or a folder holding one, refuses the change. */
export type Locked = { status: "locked" };
/** The node changed since the revision the caller read; nothing was changed. */
export type VersionConflict = { status: "version_conflict" };

export const NOT_FOUND = { status: "not_found" } as const satisfies NotFound;
export const FORBIDDEN = { status: "forbidden" } as const satisfies Forbidden;
export const LOCKED = { status: "locked" } as const satisfies Locked;
export const VERSION_CONFLICT = { status: "version_conflict" } as const satisfies VersionConflict;
