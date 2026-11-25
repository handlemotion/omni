export type StorageView = "rows" | "cards";

const CARDS: readonly [StorageView] = ["cards"];

/** `[view]` for Drive's folders: cards, always. */
export const useStorageView = () => CARDS;
