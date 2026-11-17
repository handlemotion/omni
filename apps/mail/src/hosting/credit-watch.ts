import type { Logger } from "../log.ts";
import type { MailHost } from "./mail-host.ts";

export type CreditState = "ok" | "low" | "unknown";

export function createCreditWatch(deps: { host: MailHost; warnBelowUsd: number; logger: Logger }) {
  let state: CreditState = "unknown";

  async function check() {
    let dollars: number;
    try {
      dollars = await deps.host.credit();
    } catch (error) {
      deps.logger.warn("hosting.credit_check_failed", { error });
      state = "unknown";
      return;
    }
    const next = dollars < deps.warnBelowUsd ? "low" : "ok";
    if (next === "low" && state !== "low") {
      deps.logger.error("hosting.credit_low", { dollars, warnBelowUsd: deps.warnBelowUsd });
    }
    if (next === "ok" && state === "low") deps.logger.info("hosting.credit_ok", { dollars });
    state = next;
  }

  return { check, state: () => state };
}
