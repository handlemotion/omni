// What every CRM operation shares: who is asking and in which workspace, the refusals, the
// event writer and the cursor helpers. Private to `src/crm.ts`.
import { eq, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { crmEvents } from "../schema/crm.ts";
import { personalSpaces } from "../schema/identity.ts";

/** A Drizzle database or a transaction on one. */
export type Ex = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NotFound = { status: "not_found" };
/** A Personal space, or a member who is gone: there is no CRM to reach. */
export type NoCrm = { status: "no_crm" };
/** Reachable, but only owners and admins may do this. */
export type Forbidden = { status: "forbidden" };

export const NOT_FOUND = { status: "not_found" } as const;
export const NO_CRM = { status: "no_crm" } as const;
export const FORBIDDEN = { status: "forbidden" } as const;

export interface CrmMember {
  id: string;
  orgId: string;
  /** Owner or admin of the workspace: may delete for good and edit stages. */
  admin: boolean;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

/** The member when their workspace is a company; null in a Personal space or when they are gone. */
export async function loadCrmMember(ex: Ex, memberId: string): Promise<CrmMember | null> {
  const [row] = await ex
    .select({
      id: members.id,
      orgId: members.organizationId,
      role: members.role,
      personal: sql<boolean>`exists (select 1 from ${personalSpaces} where ${personalSpaces.orgId} = ${members.organizationId})`,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row || row.personal) return null;
  // Better Auth stores several roles as a comma-separated list.
  const admin = row.role.split(",").some((role) => ADMIN_ROLES.has(role.trim()));
  return { id: row.id, orgId: row.orgId, admin };
}

/**
 * Who hears a CRM change: the workspace's members now. Every member sees every record
 * (ADR 0036 decision 1), and a member removed since they connected is not among them.
 */
export async function crmAudience(ex: Ex, member: CrmMember) {
  const rows = await ex
    .select({ id: members.id })
    .from(members)
    .where(eq(members.organizationId, member.orgId));
  return { status: "ok" as const, memberIds: rows.map((row) => row.id) };
}

/** The member door's context: the database, and how to resolve the member once per call. */
export interface CrmDoor {
  db: Db;
  memberId: string;
}

/** Runs `fn` for the member, or answers `no_crm`. Reads run on the database directly. */
export async function asMember<T>(
  door: CrmDoor,
  fn: (member: CrmMember, ex: Ex) => Promise<T>,
): Promise<T | NoCrm> {
  const member = await loadCrmMember(door.db, door.memberId);
  return member ? fn(member, door.db) : NO_CRM;
}

/**
 * A refusal found after the transaction wrote something: throwing it rolls the writes back, and
 * `writeAsMember` answers its result.
 */
export class Refusal<R extends { status: string }> extends Error {
  readonly result: R;
  constructor(result: R) {
    super(result.status);
    this.result = result;
  }
}

/** Throws `result` as a refusal: the transaction rolls back and the caller gets `result`. */
export function refuse<R extends { status: string }>(result: R): never {
  throw new Refusal(result);
}

/**
 * Runs `fn` for the member in one transaction, or answers `no_crm`. A `refuse(...)` inside rolls
 * the transaction back and answers that refusal; every type it can carry must be in `T`.
 */
export async function writeAsMember<T>(
  door: CrmDoor,
  fn: (member: CrmMember, tx: Ex) => Promise<T>,
): Promise<T | NoCrm> {
  try {
    return await door.db.transaction(async (tx) => {
      const member = await loadCrmMember(tx, door.memberId);
      return member ? fn(member, tx) : NO_CRM;
    });
  } catch (error) {
    if (error instanceof Refusal) return error.result as T;
    throw error;
  }
}

/** The record an event, a note or a timeline is about. */
export type CrmRecordRef = { companyId: string } | { personId: string } | { dealId: string };

export type CrmEventKind =
  | "created"
  | "updated"
  | "archived"
  | "stage_moved"
  | "owner_changed"
  | "value_changed"
  | "people_set"
  | "domain_added"
  | "domain_removed"
  | "address_added"
  | "address_removed";

/** Appends one event in the caller's transaction. */
export async function appendEvent(
  tx: Ex,
  member: CrmMember,
  record: CrmRecordRef,
  kind: CrmEventKind,
  data: Record<string, unknown> = {},
  dedupeKey?: string,
) {
  await tx.insert(crmEvents).values({
    orgId: member.orgId,
    ...record,
    kind,
    actorMemberId: member.id,
    data,
    dedupeKey: dedupeKey ?? null,
  });
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

export const pageSize = (limit?: number) =>
  Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE), 1), MAX_PAGE);

/** A list ordered by name: the last row's name and id. */
export interface CrmNameCursor {
  name: string;
  id: string;
}

/** Rows after the cursor in `(lower(name), id)` order. */
export function afterName(name: AnyColumn, id: AnyColumn, cursor?: CrmNameCursor | null) {
  if (!cursor) return undefined;
  return sql`(lower(${name}), ${id}) > (lower(${cursor.name}), ${cursor.id})`;
}

/** Cuts a page fetched with one extra row and gives the next cursor. */
export function namePage<T extends { name: string; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? { name: last.name, id: last.id } : null,
  };
}

/** Escapes `%`, `_` and `\` for a `like` pattern. */
export const likePrefix = (word: string) => `${word.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Lowercased words of a query, without empties. */
export const wordsOf = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 8);

/** ISO 4217 as stored: three uppercase letters. */
export const isCurrency = (value: string) => /^[A-Z]{3}$/.test(value);

/** Postgres refused a row for a unique key. */
export function isUniqueViolation(error: unknown) {
  return pgCode(error) === "23505";
}

/** Postgres refused a delete or insert for a foreign key. */
export function isForeignKeyViolation(error: unknown) {
  return pgCode(error) === "23503";
}

function pgCode(error: unknown) {
  return (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
}

/** Keys of `patch` whose value differs from `current`, in a stable order. */
export function changedFields<T extends object>(current: T, patch: Partial<T>): (keyof T)[] {
  return (Object.keys(patch) as (keyof T)[])
    .filter((key) => patch[key] !== undefined && patch[key] !== current[key])
    .toSorted();
}
