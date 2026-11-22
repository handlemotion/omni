import { normalizeAddress } from "@omni/mail-core/addresses";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  mailboxAccess,
  mailboxCrmSharing,
  mailboxCrmSharingLevel,
  mailboxes,
  members,
  messages,
  teams,
  threadParticipants,
  threads,
  users,
} from "../schema/index.ts";

export const CRM_SHARING_LEVELS = mailboxCrmSharingLevel.enumValues;
export type CrmSharingLevel = (typeof CRM_SHARING_LEVELS)[number];

/** The most items one `sharedActivityWith` call returns. */
export const SHARED_ACTIVITY_MAX = 100;

export interface SharedActivityOptions {
  /** Any letter case; normalized as they are stored. */
  addresses?: readonly string[];
  /** Anyone at these domains, any letter case. */
  domains?: readonly string[];
  /** Only items older than this: the last item of the page before. */
  before?: { lastMessageAt: Date; key: string };
  /** Default 50, at most `SHARED_ACTIVITY_MAX`. */
  limit?: number;
}

export interface SharedActivity {
  /** Opaque and stable per thread; never the thread id. */
  key: string;
  /** A personal mailbox shows its owner's name; a shared inbox its own name. */
  mailbox: { kind: "personal" | "shared"; name: string };
  lastMessageAt: Date;
  /** `out` when the last message was sent from the mailbox's own address. */
  direction: "in" | "out";
  /** Only at `subjects`; null at `activity`. */
  subject: string | null;
}

export type CrmSharingResult =
  | { status: "ok"; level: CrmSharingLevel }
  | { status: "not_found" }
  | { status: "forbidden" };

const ADMIN_ROLES = new Set(["owner", "admin"]);

async function memberOf(db: Db, memberId: string) {
  const [row] = await db
    .select({
      orgId: members.organizationId,
      role: members.role,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row) return null;
  const admin = row.role.split(",").some((role) => ADMIN_ROLES.has(role.trim()));
  return { orgId: row.orgId, admin };
}

async function mayManage(db: Db, memberId: string, mailboxId: string) {
  const member = await memberOf(db, memberId);
  if (!member) return { status: "not_found" } as const;
  const [mailbox] = await db
    .select({
      kind: mailboxes.kind,
      owns: sql<boolean>`exists (select 1 from ${mailboxAccess} where ${mailboxAccess.mailboxId} = ${mailboxes.id} and ${mailboxAccess.memberId} = ${memberId} and ${mailboxAccess.role} = 'owner')`,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, member.orgId)));
  if (!mailbox) return { status: "not_found" } as const;
  const allowed = mailbox.kind === "personal" ? mailbox.owns : member.admin;
  if (!allowed) return { status: "forbidden" } as const;
  return { status: "ok", orgId: member.orgId } as const;
}

async function levelOf(db: Db, mailboxId: string) {
  const [row] = await db
    .select({ level: mailboxCrmSharing.level })
    .from(mailboxCrmSharing)
    .where(eq(mailboxCrmSharing.mailboxId, mailboxId));
  return (row?.level ?? "off") satisfies CrmSharingLevel;
}

const activityKey = (threadId: SQL | string) => sql`(
  select substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-8' || substr(h, 14, 3) || '-a'
    || substr(h, 18, 3) || '-' || substr(h, 21, 12)
  from (select encode(sha256(convert_to('omni:crm-activity:' || ${threadId}, 'UTF8')), 'hex') as h) k
)`;

const normalized = (values: readonly string[] | undefined) =>
  [...new Set((values ?? []).map(normalizeAddress))].filter(Boolean);

interface ActivityRow {
  key: string;
  kind: "personal" | "shared";
  name: string;
  level: CrmSharingLevel;
  last_message_at: string | Date;
  direction: "in" | "out";
  subject: string | null;
}

async function activityRows(
  db: Db,
  input: { orgId: string; memberId: string; addresses: string[]; domains: string[] },
  options: SharedActivityOptions,
  limit: number,
) {
  const { orgId, memberId, addresses, domains } = input;
  const match = or(
    addresses.length ? sql`tp.address in ${addresses}` : null,
    domains.length ? sql`tp.domain in ${domains}` : null,
  );
  const before = options.before
    ? sql`and (t.last_message_at, ${activityKey(sql`t.id`)}) < (${options.before.lastMessageAt.toISOString()}::timestamptz, ${options.before.key})`
    : sql``;
  const ownerName = sql`(select u.name from ${mailboxAccess} oa
      join ${members} om on om.id = oa.member_id and om.organization_id = mb.org_id
      join ${users} u on u.id = om.user_id
      where oa.mailbox_id = mb.id order by oa.role, oa.created_at limit 1)`;
  return (await db.execute(sql`
    with shared as (
      select mb.id, mb.address, mb.kind, s.level,
        case when mb.kind = 'personal' then coalesce(${ownerName}, mb.address)
          else coalesce(tm.name, mb.address) end as name
      from ${mailboxCrmSharing} s
      join ${mailboxes} mb on mb.id = s.mailbox_id and mb.org_id = s.org_id
      left join ${teams} tm on tm.id = mb.team_id and tm.organization_id = mb.org_id
      where s.org_id = ${orgId} and s.level <> 'off'
        and not exists (select 1 from ${mailboxAccess} ma
          where ma.mailbox_id = mb.id and ma.member_id = ${memberId})
    )
    select p.key, sh.kind, sh.name, sh.level, p.last_message_at,
      case when lower(lm.from_address) = lower(sh.address) then 'out' else 'in' end as direction,
      case when sh.level = 'subjects' then lm.subject else null end as subject
    from shared sh
    cross join lateral (
      select t.id, t.last_message_at, ${activityKey(sql`t.id`)} as key
      from ${threads} t
      where t.mailbox_id = sh.id and t.org_id = ${orgId}
        and t.id in (select tp.thread_id from ${threadParticipants} tp
          where tp.mailbox_id = sh.id and ${match})
        ${before}
      order by t.last_message_at desc, key desc
      limit ${limit}
    ) p
    left join lateral (
      select m.from_address, m.subject from ${messages} m
      where m.thread_id = p.id order by m.sent_at desc, m.id desc limit 1
    ) lm on true
    order by p.last_message_at desc, p.key desc
    limit ${limit}
  `)) as unknown as ActivityRow[];
}

const or: (a: SQL | null, b: SQL | null) => SQL = (a, b) => {
  if (a && b) return sql`(${a} or ${b})`;
  return a ?? b ?? sql`false`;
};

/** The member door's sharing setting and read. `forMember` spreads it. */
export function memberCrmSharing(db: Db, memberId: string) {
  return {
    async crmSharing(mailboxId: string) {
      const allowed = await mayManage(db, memberId, mailboxId);
      if (allowed.status !== "ok") return allowed satisfies CrmSharingResult;
      return { status: "ok", level: await levelOf(db, mailboxId) } satisfies CrmSharingResult;
    },

    async setCrmSharing(mailboxId: string, level: CrmSharingLevel) {
      const allowed = await mayManage(db, memberId, mailboxId);
      if (allowed.status !== "ok") return allowed satisfies CrmSharingResult;
      await db
        .insert(mailboxCrmSharing)
        .values({ mailboxId, orgId: allowed.orgId, level, updatedByMemberId: memberId })
        .onConflictDoUpdate({
          target: mailboxCrmSharing.mailboxId,
          set: { level, updatedByMemberId: memberId, updatedAt: new Date() },
        });
      return { status: "ok", level } satisfies CrmSharingResult;
    },

    async sharedActivityWith(options: SharedActivityOptions) {
      const addresses = normalized(options.addresses);
      const domains = normalized(options.domains);
      if (addresses.length === 0 && domains.length === 0) return [] satisfies SharedActivity[];
      const member = await memberOf(db, memberId);
      if (!member) return [] satisfies SharedActivity[];
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), SHARED_ACTIVITY_MAX);
      const rows = await activityRows(
        db,
        { orgId: member.orgId, memberId, addresses, domains },
        options,
        limit,
      );
      return rows.map((row) => ({
        key: row.key,
        mailbox: { kind: row.kind, name: row.name },
        lastMessageAt: new Date(row.last_message_at),
        direction: row.direction,
        subject: row.level === "subjects" ? row.subject : null,
      })) satisfies SharedActivity[];
    },
  };
}
