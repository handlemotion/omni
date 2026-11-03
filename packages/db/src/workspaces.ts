// Workspace setup progress (resumable onboarding) and the workspace switcher's read: every org a
// user belongs to, with its setup step and the mailboxes that user's member there can open.
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  mailboxAccess,
  mailboxes,
  members,
  organizations,
  orgSetup,
  setupStep,
} from "./schema/index.ts";

export type SetupStep = (typeof setupStep.enumValues)[number];

/** Setup steps in order: `created → domain_added → dns_verified → mailboxes_created → invites_sent → complete`. */
export const SETUP_STEPS = setupStep.enumValues;

/**
 * The step of an org with no `org_setup` row: one made by the `org:create` CLI or before setup
 * was tracked. With a mailbox it is in use, so `complete`; without one it still needs setup.
 */
function stepWithoutRow(orgId: SQL | string) {
  return sql`(case when exists (select 1 from ${mailboxes} m where m.org_id = ${orgId}) then 'complete' else 'created' end)::setup_step`;
}

function currentStep(orgId: string) {
  return sql`coalesce((select s.step from ${orgSetup} s where s.org_id = ${orgId}), ${stepWithoutRow(orgId)})`;
}

/** Where `orgId`'s setup stands. */
export async function orgSetupStep(db: Db, orgId: string): Promise<SetupStep> {
  const [row] = await db
    .select({ step: sql<SetupStep>`${currentStep(orgId)}` })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row?.step ?? "created";
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
): Promise<SetupStep> {
  const current = currentStep(orgId);
  await db.execute(sql`
    insert into ${orgSetup} (org_id, step)
    select ${orgId}, greatest(${step}::setup_step, ${current})
    ${options.onlyFrom ? sql`where ${current} >= ${options.onlyFrom}::setup_step` : sql``}
    on conflict (org_id) do update
      set step = greatest(${orgSetup.step}, excluded.step), updated_at = now()`);
  return orgSetupStep(db, orgId);
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  /** This user's role in it. */
  role: string;
  setup: SetupStep;
  /** Only mailboxes this user's member in the workspace has a grant on. */
  mailboxes: { id: string; address: string; kind: "personal" | "shared" }[];
}

/**
 * Every organization `userId` belongs to, oldest membership first, each with its setup step and
 * the mailboxes their member there can access (personal first, then by address). A mailbox
 * shows only through a grant to a member of the mailbox's own org.
 */
export async function listUserWorkspaces(db: Db, userId: string): Promise<Workspace[]> {
  const [orgs, boxes] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
        role: members.role,
        setup: sql<SetupStep>`coalesce(${orgSetup.step}, ${stepWithoutRow(sql`${organizations.id}`)})`,
      })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .leftJoin(orgSetup, eq(orgSetup.orgId, organizations.id))
      .where(eq(members.userId, userId))
      .orderBy(asc(members.createdAt), asc(organizations.id)),
    db
      .select({
        orgId: mailboxes.orgId,
        id: mailboxes.id,
        address: mailboxes.address,
        kind: mailboxes.kind,
      })
      .from(mailboxes)
      .innerJoin(mailboxAccess, eq(mailboxAccess.mailboxId, mailboxes.id))
      .innerJoin(
        members,
        and(
          eq(members.id, mailboxAccess.memberId),
          eq(members.organizationId, mailboxes.orgId),
          eq(members.userId, userId),
        ),
      )
      .orderBy(asc(mailboxes.kind), asc(mailboxes.address)),
  ]);
  return orgs.map((org) => ({
    ...org,
    mailboxes: boxes
      .filter((box) => box.orgId === org.id)
      .map(({ id, address, kind }) => ({ id, address, kind })),
  }));
}
