import { pushTokensFor, type Db } from "@omni/db";
import type { Config } from "./env.ts";
import { createLogger } from "./log.ts";

const EXPO_PUSH_TIMEOUT_MS = 10_000;

/** A push to these members' phones; failures are logged and dropped. */
export const pushToMembers = (
  db: Db,
  config: Config,
  memberIds: string[],
  message: { title: string; body: string },
) => sendExpoPush(db, config, memberIds, message);

export async function sendExpoPush(
  db: Db,
  config: Config,
  memberIds: string[],
  message: { title: string; body: string },
) {
  const tokens = await pushTokensFor(db, memberIds);
  if (tokens.length === 0) return;
  const log = createLogger({ component: "realtime" });
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.EXPO_ACCESS_TOKEN
          ? { authorization: `Bearer ${config.EXPO_ACCESS_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(tokens.map((t) => ({ to: t.expoToken, ...message, sound: "default" }))),
      signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
    });
    if (!response.ok) log.warn("expo.push_failed", { status: response.status });
  } catch (error) {
    log.warn("expo.push_failed", { error });
  }
}
