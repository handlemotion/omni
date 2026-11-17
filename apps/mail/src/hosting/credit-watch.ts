// Watches the host account's prepaid credit (plan H-5). Purelymail stops mail when credit runs
// out, so a warning has to come well before that. `/health` reads the last result and never calls
// the host itself.
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
    // Once when it drops below the line, and again after each restart while it stays there.
    if (next === "low" && state !== "low") {
      deps.logger.error("hosting.credit_low", { dollars, warnBelowUsd: deps.warnBelowUsd });
    }
    if (next === "ok" && state === "low") deps.logger.info("hosting.credit_ok", { dollars });
    state = next;
  }

  return { check, state: () => state };
}
