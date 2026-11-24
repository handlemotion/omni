import { createContext, use } from "react";

/**
 * Whether the folder is shown in a pane with no header of its own (a CRM record's Files tab): its
 * cards are compact, and its actions live only in the bar under it, not in its empty state.
 */
export const InPane = createContext(false);

export const useInPane = () => use(InPane);
