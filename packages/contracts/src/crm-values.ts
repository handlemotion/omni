/** What a stage means; the name is the workspace's. */
export const CRM_STAGE_KINDS = ["open", "won", "done", "lost"] as const;

/** `draft` → `sent` → `signed` → `ended`; `draft` may go straight to `signed`, `sent` back. */
export const CRM_CONTRACT_STATUSES = ["draft", "sent", "signed", "ended"] as const;

export const CRM_NOTE_MAX_LENGTH = 20_000;
/** At most this many people involved in one contract. */
export const CONTRACT_PEOPLE_MAX = 20;
/** At most this many records in one bulk change. */
export const BULK_MAX = 200;
