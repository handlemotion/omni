import { randomUUID } from "expo-crypto";

/** One key per user intent: mutating routes require it, and a retry reuses it. */
export function idempotencyKey() {
  return randomUUID();
}
