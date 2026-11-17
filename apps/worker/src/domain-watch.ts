import { DurableObject } from "cloudflare:workers";
import { findMemberDomain, orgDomainAdmins } from "@omni/db";
import { openDb } from "./db.ts";
import { advanceDomainStep, checkDomain, DomainError, domainView } from "./domains.ts";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";

/** Seconds before each check; the last repeats. */
export const WATCH_DELAYS_S = [5, 10, 30, 60] as const;
const LEASE_MS = 2 * 60_000;
const MAX_WATCH_MS = 30 * 60_000;

interface WatchState {
  claimId: string;
  orgId: string;
  memberId: string;
  attempt: number;
  leaseUntil: number;
  startedAt: number;
}

export class DomainWatch extends DurableObject<Env> {
  /**
   * Starts or renews the watch. `reset` (the page came back into focus, so someone may have just
   * saved a record) restarts the backoff from 5 s. Returns when the next check runs.
   */
  async watch(input: { claimId: string; orgId: string; memberId: string; reset: boolean }) {
    const now = Date.now();
    const previous = await this.ctx.storage.get<WatchState>("state");
    const fresh = !previous || input.reset || previous.leaseUntil < now;
    const state: WatchState = {
      ...input,
      attempt: fresh ? 0 : previous.attempt,
      startedAt: fresh ? now : previous.startedAt,
      leaseUntil: now + LEASE_MS,
    };
    await this.ctx.storage.put("state", state);
    const due = now + delay(state.attempt);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || (fresh && alarm > due)) {
      await this.ctx.storage.setAlarm(due);
      return { nextCheckAt: due } satisfies { nextCheckAt: number };
    }
    return { nextCheckAt: alarm } satisfies { nextCheckAt: number };
  }

  override async alarm() {
    const state = await this.ctx.storage.get<WatchState>("state");
    if (!state) return;
    const now = Date.now();
    if (now > state.leaseUntil || now - state.startedAt > MAX_WATCH_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const keepGoing = await this.check(state);
    if (!keepGoing) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const attempt = state.attempt + 1;
    await this.ctx.storage.put("state", { ...state, attempt });
    await this.ctx.storage.setAlarm(Date.now() + delay(attempt));
  }

  private async check(state: WatchState) {
    const config = loadConfig(this.env);
    const requestId = crypto.randomUUID();
    const log = createLogger({ component: "domain-watch", orgId: state.orgId, requestId });
    const { success } = await this.env.DOMAIN_CHECK_LIMITER.limit({ key: state.orgId });
    if (!success) return true;
    const { db, close } = openDb(this.env);
    try {
      const setup = await findMemberDomain(db, state.memberId, state.claimId);
      if (!setup) return false;
      const deps = {
        db,
        config,
        requestId,
        log,
        email: this.env.EMAIL,
        waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      };
      let done = false;
      try {
        const result = await checkDomain(deps, { id: state.memberId, orgId: state.orgId }, setup);
        const view = domainView(result.setup, { addError: result.addError });
        await advanceDomainStep(db, state.orgId, view);
        done = view.verified && view.challenge?.verified !== false;
      } catch (error) {
        if (error instanceof DomainError && [404, 409, 410].includes(error.status)) done = true;
        else log.warn("domain_watch.check_failed", { error });
      }
      const admins = await orgDomainAdmins(db, state.orgId);
      const realtime = this.env.REALTIME.get(this.env.REALTIME.idFromName(state.orgId));
      await realtime.broadcast(admins, { type: "domain", domainId: state.claimId });
      return !done;
    } finally {
      this.ctx.waitUntil(close());
    }
  }
}

function delay(attempt: number) {
  return WATCH_DELAYS_S[Math.min(attempt, WATCH_DELAYS_S.length - 1)]! * 1000;
}
