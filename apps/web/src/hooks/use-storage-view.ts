import { storedChoice } from "../lib/stored-preference.ts";

export type StorageView = "rows" | "cards";

/** `[view, setView]` for Drive's folders. */
export const useStorageView = storedChoice<StorageView>(
  "omni:storage-view",
  ["rows", "cards"],
  "cards",
);
