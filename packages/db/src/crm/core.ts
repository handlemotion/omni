import { and, asc, eq, inArray, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { crmEvents, crmProjectMembers } from "../schema/crm.ts";
import { listSignInEmails } from "../sign-in-emails.ts";

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
  /**
   * Null for a teammate, who reaches every record. A freelancer's projects: the deals they were
   * added to, and nothing else (`docs/spec/crm.md`, "Project access").
   */
  projects: string[] | null;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);
export const FREELANCER_ROLE = "freelancer";

/** Narrows a deal query to the member's projects; a teammate's is not narrowed. */
export const projectsOnly = (dealId: AnyColumn, member: CrmMember) => {
  if (member.projects === null) return undefined;
  return member.projects.length > 0 ? inArray(dealId, member.projects) : sql`false`;
};

export const hasRole = (roles: string, role: string) =>
  roles.split(",").some((one) => one.trim() === role);

async function projectsOf(ex: Ex, orgId: string, userId: string) {
  const addresses = (await listSignInEmails(ex as Db, userId))
    .filter((address) => address.verified)
    .map((address) => address.email.toLowerCase());
  if (addresses.length === 0) return [];
  const rows = await ex
    .select({ dealId: crmProjectMembers.dealId })
    .from(crmProjectMembers)
    .where(
      and(
        eq(crmProjectMembers.orgId, orgId),
        eq(crmProjectMembers.scope, "freelancer"),
        inArray(crmProjectMembers.email, addresses),
      ),
    );
  return [...new Set(rows.map((row) => row.dealId))];
}

/** The member; null when they are gone. */
export const loadCrmMember: (ex: Ex, memberId: string) => Promise<CrmMember | null> = async (
  ex,
  memberId,
) => {
  const [row] = await ex
    .select({
      id: members.id,
      orgId: members.organizationId,
      role: members.role,
      userId: members.userId,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row) return null;
  const admin = row.role.split(",").some((role) => ADMIN_ROLES.has(role.trim()));
  const projects =
    !admin && hasRole(row.role, FREELANCER_ROLE)
      ? await projectsOf(ex, row.orgId, row.userId)
      : null;
  return { id: row.id, orgId: row.orgId, admin, projects };
};

/**
 * A teammate to act for the workspace when no person is: `preferred` while they are still a
 * teammate, else its longest-standing owner or admin.
 */
export async function teammateFor(ex: Ex, orgId: string, preferred: string | null) {
  const first = preferred ? await loadCrmMember(ex, preferred) : null;
  if (first && first.orgId === orgId && first.projects === null) return first;
  const rows = await ex
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.organizationId, orgId))
    .orderBy(asc(members.createdAt), asc(members.id));
  const admin = rows.find((row) => row.role.split(",").some((r) => ADMIN_ROLES.has(r.trim())));
  return admin ? loadCrmMember(ex, admin.id) : null;
}

/**
 * Who hears a CRM change: the workspace's teammates now. A member removed since they connected
 * is not among them, and neither is a freelancer, who would learn other records' ids.
 */
export async function crmAudience(ex: Ex, member: CrmMember) {
  const rows = await ex
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.organizationId, member.orgId));
  const team = rows.filter((row) => !hasRole(row.role, FREELANCER_ROLE));
  return { status: "ok" as const, memberIds: team.map((row) => row.id) };
}

/** The member door's context: the database, and how to resolve the member once per call. */
export interface CrmDoor {
  db: Db;
  memberId: string;
}

/** A freelancer: a member who reaches only their projects. */
export type Freelancer = CrmMember & { projects: string[] };

/**
 * Whether a freelancer may run a door operation. Teammates always may. Without a gate an
 * operation is for teammates only, so a new one is closed to freelancers until it says otherwise.
 */
export type Gate = (member: Freelancer, ex: Ex) => boolean | Promise<boolean>;

export const TEAM_ONLY: Gate = () => false;
export const ANYONE: Gate = () => true;

const isFreelancer = (member: CrmMember): member is Freelancer => member.projects !== null;

async function admits(member: CrmMember, ex: Ex, gate: Gate) {
  return !isFreelancer(member) || (await gate(member, ex));
}

/**
 * Runs `fn` for the member, or answers `no_crm`; a freelancer the gate turns away gets
 * `not_found`, as for a record in another workspace. Reads run on the database directly.
 */
export async function asMember<T>(
  door: CrmDoor,
  fn: (member: CrmMember, ex: Ex) => Promise<T>,
  gate: Gate = TEAM_ONLY,
) {
  const member = await loadCrmMember(door.db, door.memberId);
  if (!member) return NO_CRM;
  if (!(await admits(member, door.db, gate))) return NOT_FOUND;
  return fn(member, door.db);
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
  gate: Gate = TEAM_ONLY,
) {
  try {
    return (await door.db.transaction(async (tx) => {
      const member = await loadCrmMember(tx, door.memberId);
      if (!member) return NO_CRM;
      if (!(await admits(member, tx, gate))) return NOT_FOUND;
      return fn(member, tx);
    })) satisfies T | NoCrm | NotFound;
  } catch (error) {
    if (error instanceof Refusal) return error.result as T satisfies T | NoCrm;
    throw error;
  }
}

/** The record an event, a note or a timeline is about. */
export type CrmRecordRef = { companyId: string } | { personId: string } | { dealId: string };

export type CrmEventKind =
  | "created"
  | "updated"
  | "archived"
  | "restored"
  | "stage_moved"
  | "owner_changed"
  | "value_changed"
  | "people_set"
  | "domain_added"
  | "domain_removed"
  | "address_added"
  | "address_removed"
  | "contract_created"
  | "contract_status_changed"
  | "contract_document_changed"
  | "contract_deleted";

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
export function changedFields<T extends object>(current: T, patch: Partial<T>) {
  return (Object.keys(patch) as (keyof T)[])
    .filter((key) => patch[key] !== undefined && patch[key] !== current[key])
    .toSorted() satisfies (keyof T)[];
}
