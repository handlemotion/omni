import { DurableObject } from "cloudflare:workers";

/**
 * Remembers the nonces of signed calls the Worker accepted, for as long as their timestamps are
 * valid, so a captured request cannot be replayed inside the window. One instance (strongly
 * consistent) per caller.
 */
export class ReplayGuard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "create table if not exists nonces (nonce text primary key, expires_at integer not null)",
    );
  }

  /** True the first time a nonce is seen; false for a replay. `expiresAt` is epoch ms. */
  async claim(nonce: string, expiresAt: number): Promise<boolean> {
    const inserted = this.ctx.storage.sql.exec(
      "insert into nonces (nonce, expires_at) values (?, ?) on conflict do nothing",
      nonce,
      expiresAt,
    ).rowsWritten;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
    return inserted > 0;
  }

  override async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec("delete from nonces where expires_at <= ?", now);
    const next = this.ctx.storage.sql
      .exec<{ next: number | null }>("select min(expires_at) as next from nonces")
      .one().next;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
