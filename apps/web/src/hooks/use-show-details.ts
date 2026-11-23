import { storedToggle } from "../lib/stored-preference.ts";

/** `[shown, toggle]` for an open file's details bar: hidden unless the person showed it. */
export const useShowDetails = storedToggle("omni:file-details");
