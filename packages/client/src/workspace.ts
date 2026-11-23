import type { Workspace } from "./api.ts";

/** The name a Personal space is made with (`personal-space.ts`), until its owner renames it. */
export const PERSONAL_DEFAULT_NAME = "Personal";

/**
 * A workspace as the person reads it: a company by its name; their Personal space as their own
 * ("Rodrigo's Workspace"), from the first word of their name.
 */
export function workspaceLabel(
  workspace: Pick<Workspace, "kind" | "name">,
  userName?: string | null,
) {
  if (workspace.kind !== "personal" || workspace.name !== PERSONAL_DEFAULT_NAME)
    return workspace.name;
  const first = userName?.trim().split(/\s+/)[0];
  return first ? `${first}'s Workspace` : "Personal Workspace";
}
