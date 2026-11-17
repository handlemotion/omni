/** How a name was finished: Enter, Esc, or leaving the field (a click, Tab, another page). */
export type FinishedBy = "enter" | "escape" | "blur";

/** The longest name the API takes. */
export const NAME_MAX = 255;

/** What a new folder is called until it is named. */
export const NEW_FOLDER_NAME = "Untitled folder";

/**
 * A name as typed or pasted, kept to what the Worker takes: line breaks and tabs become one
 * space, slashes and other control characters go. Not trimmed: the person is still typing.
 */
export function typedName(value: string) {
  return (
    value
      .replace(/[\r\n\t]+/g, " ")
      // oxlint-disable-next-line no-control-regex
      .replace(/[/\\\u0000-\u001f\u007f]/g, "")
      .slice(0, NAME_MAX)
  );
}

/** Why a finished name cannot be used, or null when it can. */
export function nameProblem(name: string, siblings: Iterable<string>) {
  if (!name || name === "." || name === "..") return "invalid_name" as const;
  const lower = name.toLowerCase();
  for (const sibling of siblings) if (sibling.toLowerCase() === lower) return "name_taken" as const;
  return null;
}

/**
 * The first of "Untitled folder", "Untitled folder (1)", "Untitled folder (2)"… that no sibling
 * has: the numbering the Worker gives a taken name.
 */
export function freeFolderName(siblings: Iterable<string>) {
  const taken = new Set([...siblings].map((name) => name.toLowerCase()));
  if (!taken.has(NEW_FOLDER_NAME.toLowerCase())) return NEW_FOLDER_NAME;
  for (let n = 1; ; n += 1) {
    const name = `${NEW_FOLDER_NAME} (${n})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
