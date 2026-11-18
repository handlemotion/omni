import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.ts";
import { isCompany } from "./personal-space.ts";
import { mailboxesOpenTo, orgHasMailbox } from "./mail.ts";
import { members, organizations, orgSetup, setupStep } from "./schema/index.ts";

export type SetupStep = (typeof setupStep.enumValues)[number];

/** Setup steps in order: `created → domain_added → dns_verified → mailboxes_created → invites_sent → complete`. */
export const SETUP_STEPS = setupStep.enumValues;

function stepWithoutRow(orgId: SQL | string) {
  return sql`(case when ${orgHasMailbox(orgId)} then 'complete' else 'created' end)::setup_step`;
}

function currentStep(orgId: string) {
  return sql`coalesce((select s.step from ${orgSetup} s where s.org_id = ${orgId}), ${stepWithoutRow(orgId)})`;
}

/** Where `orgId`'s setup stands. */
export async function orgSetupStep(db: Db, orgId: string) {
  const [row] = await db
    .select({ step: sql<SetupStep>`${currentStep(orgId)}` })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return (row?.step ?? "created") satisfies SetupStep;
}

/**
 * Moves `orgId`'s setup forward to `step`. Never backwards: a step behind the saved one changes
 * nothing, so a retry, a double submit or a late request is harmless. With `onlyFrom`, it moves
 * only once setup has reached that step (an invitation sent before any mailbox exists is not
 * the invite step). Returns the step setup is at afterwards.
 */
export async function advanceOrgSetup(
  db: Db,
  orgId: string,
  step: SetupStep,
  options: { onlyFrom?: SetupStep } = {},
) {
  const current = currentStep(orgId);
  await db.execute(sql`
    insert into ${orgSetup} (org_id, step)
    select ${orgId}, greatest(${step}::setup_step, ${current})
    ${options.onlyFrom ? sql`where ${current} >= ${options.onlyFrom}::setup_step` : sql``}
    on conflict (org_id) do update
      set step = greatest(${orgSetup.step}, excluded.step), updated_at = now()`);
  return orgSetupStep(db, orgId) satisfies Promise<SetupStep>;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  /** `personal` (the user's own, ADR 0024) or `company`. */
  kind: "personal" | "company";
  /** This user's role in it. */
  role: string;
  setup: SetupStep;
  /** Only mailboxes this user's member in the workspace has a grant on. */
  mailboxes: {
    id: string;
    address: string;
    kind: "personal" | "shared";
    /** What its owner calls a personal inbox; null when unlabelled. */
    label: string | null;
    /** The account's own picture URL, when its provider gave one. */
    picture: string | null;
  }[];
}

/**
 * Every organization `userId` belongs to, oldest membership first, each with its setup step and
 * the mailboxes their member there can access (personal first, then by address). A mailbox
 * shows only through a grant to a member of the mailbox's own org. The user's Personal space is
 * left out unless `includePersonal`: clients from before ADR 0024 would show it as a company.
 */
export async function listUserWorkspaces(
  db: Db,
  userId: string,
  options: { includePersonal?: boolean } = {},
) {
  const [orgs, boxes] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
        kind: sql<
          Workspace["kind"]
        >`case when ${isCompany(db, organizations.id)} then 'company' else 'personal' end`,
        role: members.role,
        setup: sql<SetupStep>`coalesce(${orgSetup.step}, ${stepWithoutRow(sql`${organizations.id}`)})`,
      })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .leftJoin(orgSetup, eq(orgSetup.orgId, organizations.id))
      .where(
        and(
          eq(members.userId, userId),
          options.includePersonal ? undefined : isCompany(db, organizations.id),
        ),
      )
      .orderBy(asc(members.createdAt), asc(organizations.id)),
    mailboxesOpenTo(db, userId),
  ]);
  return orgs.map((org) => ({
    ...org,
    mailboxes: boxes
      .filter((box) => box.orgId === org.id)
      .map(({ id, address, kind, label, picture }) => ({ id, address, kind, label, picture })),
  })) satisfies Workspace[];
}
