/** How long, and how many, events stay to be replayed; past either, a reconnect refetches. */
export const KEEP_MS = 60 * 60 * 1000;
const KEEP_EVENTS = 20_000;
const PRUNE_EVERY = 256;
/** More of a socket's events than this missed, and refetching is cheaper than replaying them. */
export const MAX_REPLAY = 500;

/**
 * A recipient tag every socket of the workspace (not outsiders) hears: a Shared drive changed.
 * Never a member id, which are uuids.
 */
export const EVERYONE = "*";
/** Every `team` socket hears it (`talk.online`). */
export const TEAM = "team";
/** One member's `team` sockets hear it (`talk.message`, `talk.changed`). */
export const teamOf = (memberId: string) => `team:${memberId}`;
/** A member's desktop sync provider's socket (`SYNC_HEADER`). */
export const syncTag = (memberId: string) => `sync:${memberId}`;
/** A member's desktop watch socket (`WATCH_HEADER`). */
export const watchTag = (memberId: string) => `watch:${memberId}`;

export interface Cursor {
  epoch: string;
  seq: number;
}

/** `since=<epoch>.<seq>` as a client sends it, or null when it is not one. */
export function parseCursor(raw: string | null) {
  const match = raw?.match(/^([0-9a-f-]{36})\.(\d{1,15})$/);
  if (!match?.[1] || !match[2]) return null;
  return { epoch: match[1], seq: Number(match[2]) } satisfies Cursor;
}

type Row = Record<string, SqlStorageValue>;

export class RealtimeLog {
  private readonly sql: SqlStorage;
  readonly epoch: string;
  private head: number;
  private floor: number;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS realtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS realtime_events (
        seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, tags TEXT NOT NULL, body TEXT NOT NULL)`,
    );
    const meta = new Map(
      sql
        .exec<{ key: string; value: string }>(`SELECT key, value FROM realtime_meta`)
        .toArray()
        .map((row) => [row.key, row.value]),
    );
    this.epoch = meta.get("epoch") ?? crypto.randomUUID();
    this.head = Number(meta.get("head") ?? 0);
    this.floor = Number(meta.get("floor") ?? 0);
    if (!meta.has("epoch")) this.save("epoch", this.epoch);
  }

  /** The last event's number: a socket that has heard up to it missed nothing. */
  get seq() {
    return this.head;
  }

  /**
   * Numbers the event, keeps it for the sockets under `tags`, and returns it as sent: its JSON
   * with `seq`, the same for every recipient.
   */
  append(tags: string[], event: object) {
    const seq = ++this.head;
    const body = JSON.stringify({ ...event, seq });
    this.sql.exec(
      `INSERT INTO realtime_events (seq, at, tags, body) VALUES (?, ?, ?, ?)`,
      seq,
      Date.now(),
      JSON.stringify([...new Set(tags)]),
      body,
    );
    this.save("head", String(seq));
    if (seq % PRUNE_EVERY === 0) this.prune();
    return body;
  }

  /**
   * The events after `cursor` for a socket that hears `tags`, oldest first; null when the log
   * cannot say (another epoch, pruned past it, or too many), so the app must refetch.
   */
  since(cursor: Cursor | null, tags: string[]) {
    if (!cursor || cursor.epoch !== this.epoch || cursor.seq > this.head) return null;
    this.prune();
    if (cursor.seq < this.floor) return null;
    const marks = tags.map(() => "?").join(", ");
    const rows = this.sql
      .exec<Row>(
        `SELECT body FROM realtime_events
         WHERE seq > ? AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (${marks}))
         ORDER BY seq LIMIT ?`,
        cursor.seq,
        ...tags,
        MAX_REPLAY + 1,
      )
      .toArray();
    if (rows.length > MAX_REPLAY) return null;
    return rows.map((row) => String(row.body));
  }

  private prune() {
    const old = this.sql
      .exec<Row>(`SELECT max(seq) AS seq FROM realtime_events WHERE at < ?`, Date.now() - KEEP_MS)
      .one().seq;
    const cut = Math.max(this.head - KEEP_EVENTS, typeof old === "number" ? old : 0);
    if (cut <= this.floor) return;
    this.sql.exec(`DELETE FROM realtime_events WHERE seq <= ?`, cut);
    this.floor = cut;
    this.save("floor", String(cut));
  }

  private save(key: string, value: string) {
    this.sql.exec(
      `INSERT INTO realtime_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}

const logs = new WeakMap<DurableObjectState, RealtimeLog>();

/** The object's log, opened once per wake. */
export function logOf(ctx: DurableObjectState) {
  let log = logs.get(ctx);
  if (!log) {
    log = new RealtimeLog(ctx.storage.sql);
    logs.set(ctx, log);
  }
  return log;
}

/**
 * The tags a socket hears, from its own: an app socket its member and, on a `team` one, Talk's;
 * a sync or watch socket its own tag. All of them hear `EVERYONE`.
 */
export function tagsHeard(socketTags: string[]) {
  const [own] = socketTags;
  if (!own) return [];
  const team = socketTags.includes(TEAM) ? [TEAM, teamOf(own)] : [];
  return [own, EVERYONE, ...team];
}

/**
 * Sends what the socket missed since `since` (the client's cursor), then `sync`: where the log is
 * now, and whether what came before it is everything (`resumed`) or the app must refetch.
 */
export function greet(ctx: DurableObjectState, socket: WebSocket, since: string | null) {
  const log = logOf(ctx);
  const missed = log.since(parseCursor(since), tagsHeard(ctx.getTags(socket)));
  for (const body of missed ?? []) socket.send(body);
  socket.send(
    JSON.stringify({ type: "sync", epoch: log.epoch, seq: log.seq, resumed: missed !== null }),
  );
}

/**
 * The messages for these members' app sockets (all but `mail.arrived`) and watch sockets (the
 * `watched` types), in order. Every event but presence is logged, for the members away now.
 */
export function logForMembers(
  ctx: DurableObjectState,
  members: string[],
  events: { type: string }[],
  watched: Set<string>,
) {
  const forApps: string[] = [];
  const forWatch: string[] = [];
  for (const event of events) {
    const apps = event.type !== "mail.arrived";
    const watch = watched.has(event.type);
    const tags = [...(apps ? members : []), ...(watch ? members.map(watchTag) : [])];
    const body = event.type === "presence" ? JSON.stringify(event) : logOf(ctx).append(tags, event);
    if (apps) forApps.push(body);
    if (watch) forWatch.push(body);
  }
  return { forApps, forWatch };
}

/**
 * Who a drive's change is logged for, as `driveAudience` sends it: the teamspace's members, everyone
 * for Shared, the owner's app and sync sockets for My files.
 */
export function driveTags(ownerMemberId: string | null, reaching: Set<string> | null) {
  if (reaching) return [...reaching];
  if (ownerMemberId === null) return [EVERYONE];
  return [ownerMemberId, syncTag(ownerMemberId)];
}
