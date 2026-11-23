/** What a stage means; the name is the workspace's. */
export const CRM_STAGE_KINDS = ["open", "won", "done", "lost"] as const;

/** `draft` → `sent` → `signed` → `ended`; `draft` may go straight to `signed`, `sent` back. */
export const CRM_CONTRACT_STATUSES = ["draft", "sent", "signed", "ended"] as const;
