import { createContext, use } from "react";
import type { ListRow } from "./thread-list.tsx";

/** The rows of the list an open thread came from, and where each opens. */
export interface OpenList {
  rows: ListRow[];
  href: (threadId: string) => string;
}

export const OpenListContext = createContext<OpenList | null>(null);

/** The list behind the open thread, so it can be switched without the list on screen. */
export const useOpenList = () => use(OpenListContext);
