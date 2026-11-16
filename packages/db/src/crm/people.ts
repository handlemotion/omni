// People and their addresses. An address is one person in a workspace, and adding one that
// already has a person returns that person (ADR 0036 decision 4: add once, then automatic).
import { companyFromAddress, parseAddress } from "@omni/mail-core/addresses";
import { and, asc, eq, exists, inArray, sql } from "drizzle-orm";
import { crmPeople, crmPersonEmails } from "../schema/crm.ts";
import { companyForDomain, nameMatches, type DeleteResult, type InvalidName } from "./companies.ts";
import {
  afterName,
  appendEvent,
  FORBIDDEN,
  likePrefix,
  namePage,
  NOT_FOUND,
  pageSize,
  refuse,
  type CrmMember,
  type CrmNameCursor,
  type Ex,
  type NotFound,
} from "./core.ts";
import {
  cleanName,
  live,
  loadCompany,
  loadPerson,
  personColumns,
  withAddresses,
  type CrmPerson,
} from "./records.ts";

export type InvalidAddress = { status: "invalid_address" };
export type AddressTaken = { status: "address_taken"; address: string; personId: string };

export interface ListPeopleInput {
  q?: string;
  companyId?: string;
  cursor?: CrmNameCursor | null;
  limit?: number;
  includeArchived?: boolean;
}

export interface AddPersonInput {
  name: string;
  address: string;
  /** The person's company. Without it, the company is found or made from the address's domain. */
  companyId?: string;
  jobTitle?: string | null;
  phone?: string | null;
}

export type PersonResult = { status: "ok"; person: CrmPerson } | NotFound;
export type AddPersonResult =
  | {
      status: "ok";
      person: CrmPerson;
      /** False when the address already had a person, which is returned unchanged. */
      created: boolean;
    }
  | NotFound
  | InvalidName
  | InvalidAddress;

export interface UpdatePersonInput {
  name?: string;
  /** Null leaves the person with no company. */
  companyId?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  addresses?: {
    add?: string[];
    remove?: string[];
    /** One of the person's addresses after `add` and `remove`. */
    primary?: string;
  };
}

export type UpdatePersonResult =
  | { status: "ok"; person: CrmPerson }
  | NotFound
  | InvalidName
  | InvalidAddress
  | AddressTaken;

export async function listPeople(ex: Ex, member: CrmMember, input: ListPeopleInput) {
  const limit = pageSize(input.limit);
  const words = input.q?.trim() ? input.q : undefined;
  // A query also matches the start of an address.
  const byAddress = words
    ? exists(
        ex
          .select({ one: sql`1` })
          .from(crmPersonEmails)
          .where(
            and(
              eq(crmPersonEmails.personId, crmPeople.id),
              sql`${crmPersonEmails.address} like ${likePrefix(words.trim().toLowerCase())}`,
            ),
          ),
      )
    : undefined;
  const matches = words ? sql`(${nameMatches(crmPeople.name, words)} or ${byAddress})` : undefined;
  const rows = await ex
    .select(personColumns)
    .from(crmPeople)
    .where(
      and(
        eq(crmPeople.orgId, member.orgId),
        live(crmPeople.archivedAt, input.includeArchived),
        input.companyId ? eq(crmPeople.companyId, input.companyId) : undefined,
        matches,
        afterName(crmPeople.name, crmPeople.id, input.cursor),
      ),
    )
    .orderBy(sql`lower(${crmPeople.name})`, asc(crmPeople.id))
    .limit(limit + 1);
  const page = namePage(rows, limit);
  return {
    status: "ok" as const,
    people: await withAddresses(ex, page.items),
    nextCursor: page.nextCursor,
  };
}

export async function getPerson(ex: Ex, member: CrmMember, id: string): Promise<PersonResult> {
  const person = await loadPerson(ex, member.orgId, id);
  return person ? { status: "ok", person } : NOT_FOUND;
}

/** The person holding `address` in the workspace, or null. */
async function personWithAddress(ex: Ex, orgId: string, address: string) {
  const [row] = await ex
    .select({ personId: crmPersonEmails.personId })
    .from(crmPersonEmails)
    .where(and(eq(crmPersonEmails.orgId, orgId), eq(crmPersonEmails.address, address)));
  return row ? loadPerson(ex, orgId, row.personId) : null;
}

/**
 * Adds a person once. An address that already has a person returns that person, archived or
 * not. Otherwise the person is made and, unless the address is webmail or `companyId` is given,
 * joins the company holding its domain, made and named by `companyFromAddress` when none does.
 * Two adds of one address at once make one person: the address's unique key decides, and the
 * loser removes its own row and returns the winner's.
 */
export async function addPerson(
  tx: Ex,
  member: CrmMember,
  input: AddPersonInput,
): Promise<AddPersonResult> {
  const name = cleanName(input.name);
  if (!name) return { status: "invalid_name" };
  const address = parseAddress(input.address);
  if (!address) return { status: "invalid_address" };
  const existing = await personWithAddress(tx, member.orgId, address);
  if (existing) return { status: "ok", person: existing, created: false };

  let companyId: string | null = null;
  if (input.companyId) {
    if (!(await loadCompany(tx, member.orgId, input.companyId))) return NOT_FOUND;
    companyId = input.companyId;
  } else {
    const guess = companyFromAddress(address);
    if (guess.domain && guess.company) {
      companyId = await companyForDomain(tx, member, guess.domain, guess.company);
    }
  }
  const [person] = await tx
    .insert(crmPeople)
    .values({
      orgId: member.orgId,
      name,
      companyId,
      jobTitle: input.jobTitle ?? null,
      phone: input.phone ?? null,
      createdByMemberId: member.id,
    })
    .returning({ id: crmPeople.id });
  const claimed = await tx
    .insert(crmPersonEmails)
    .values({ orgId: member.orgId, personId: person!.id, address, isPrimary: true })
    .onConflictDoNothing()
    .returning({ address: crmPersonEmails.address });
  if (claimed.length === 0) {
    await tx.delete(crmPeople).where(eq(crmPeople.id, person!.id));
    const winner = await personWithAddress(tx, member.orgId, address);
    return { status: "ok", person: winner!, created: false };
  }
  await appendEvent(tx, member, { personId: person!.id }, "created", { address });
  return { status: "ok", person: (await loadPerson(tx, member.orgId, person!.id))!, created: true };
}

const normalizeAll = (list: string[] = []) => list.map((raw) => parseAddress(raw));

/** Applies an address change list; refuses (rolling back) an address another person holds. */
async function changeAddresses(
  tx: Ex,
  member: CrmMember,
  person: CrmPerson,
  change: NonNullable<UpdatePersonInput["addresses"]>,
) {
  const add = normalizeAll(change.add);
  const remove = normalizeAll(change.remove);
  const primary = change.primary === undefined ? undefined : parseAddress(change.primary);
  if (add.includes(null) || remove.includes(null) || primary === null) {
    return { status: "invalid_address" as const };
  }
  const had = new Set(person.addresses.map((a) => a.address));
  const added = [...new Set(add as string[])].filter((address) => !had.has(address));
  const removed = [...new Set(remove as string[])].filter(
    (address) => had.has(address) && !added.includes(address),
  );
  if (removed.length > 0) {
    await tx
      .delete(crmPersonEmails)
      .where(
        and(eq(crmPersonEmails.personId, person.id), inArray(crmPersonEmails.address, removed)),
      );
    await appendEvent(tx, member, { personId: person.id }, "address_removed", {
      addresses: removed,
    });
  }
  for (const address of added) {
    const made = await tx
      .insert(crmPersonEmails)
      .values({ orgId: member.orgId, personId: person.id, address, isPrimary: false })
      .onConflictDoNothing()
      .returning({ address: crmPersonEmails.address });
    if (made.length === 0) {
      const [holder] = await tx
        .select({ personId: crmPersonEmails.personId })
        .from(crmPersonEmails)
        .where(and(eq(crmPersonEmails.orgId, member.orgId), eq(crmPersonEmails.address, address)));
      refuse({ status: "address_taken", address, personId: holder?.personId ?? "" });
    }
  }
  if (added.length > 0) {
    await appendEvent(tx, member, { personId: person.id }, "address_added", { addresses: added });
  }
  return setPrimary(tx, person.id, primary ?? undefined);
}

/** Makes `address` the primary one, or keeps one primary when the old primary was removed. */
async function setPrimary(tx: Ex, personId: string, address?: string) {
  const rows = await tx
    .select({ address: crmPersonEmails.address, isPrimary: crmPersonEmails.isPrimary })
    .from(crmPersonEmails)
    .where(eq(crmPersonEmails.personId, personId))
    .orderBy(asc(crmPersonEmails.address));
  if (address !== undefined && !rows.some((row) => row.address === address)) {
    return { status: "invalid_address" as const };
  }
  const target = address ?? rows.find((row) => row.isPrimary)?.address ?? rows[0]?.address;
  if (!target || rows.find((row) => row.isPrimary)?.address === target) {
    return { status: "ok" as const, primaryChanged: false };
  }
  await tx
    .update(crmPersonEmails)
    .set({ isPrimary: false })
    .where(and(eq(crmPersonEmails.personId, personId), eq(crmPersonEmails.isPrimary, true)));
  await tx
    .update(crmPersonEmails)
    .set({ isPrimary: true })
    .where(and(eq(crmPersonEmails.personId, personId), eq(crmPersonEmails.address, target)));
  return { status: "ok" as const, primaryChanged: true };
}

type PersonFields = Pick<CrmPerson, "name" | "companyId" | "jobTitle" | "phone">;

export async function updatePerson(
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: UpdatePersonInput,
): Promise<UpdatePersonResult> {
  const person = await loadPerson(tx, member.orgId, id, true);
  if (!person) return NOT_FOUND;
  const next: Partial<PersonFields> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (!name) return { status: "invalid_name" };
    next.name = name;
  }
  if (patch.companyId) {
    if (!(await loadCompany(tx, member.orgId, patch.companyId))) return NOT_FOUND;
  }
  if (patch.companyId !== undefined) next.companyId = patch.companyId;
  if (patch.jobTitle !== undefined) next.jobTitle = patch.jobTitle;
  if (patch.phone !== undefined) next.phone = patch.phone;
  const fields = (Object.keys(next) as (keyof PersonFields)[])
    .filter((key) => next[key] !== person[key])
    .toSorted();
  if (patch.addresses) {
    const changed = await changeAddresses(tx, member, person, patch.addresses);
    if (changed.status !== "ok") refuse(changed);
    if (changed.primaryChanged) {
      await appendEvent(tx, member, { personId: id }, "updated", { fields: ["primaryAddress"] });
    }
  }
  if (fields.length > 0) {
    await tx
      .update(crmPeople)
      .set(Object.fromEntries(fields.map((key) => [key, next[key]])))
      .where(eq(crmPeople.id, id));
    await appendEvent(tx, member, { personId: id }, "updated", { fields });
  }
  return { status: "ok", person: (await loadPerson(tx, member.orgId, id))! };
}

export async function archivePerson(tx: Ex, member: CrmMember, id: string): Promise<PersonResult> {
  const person = await loadPerson(tx, member.orgId, id, true);
  if (!person) return NOT_FOUND;
  if (person.archivedAt) return { status: "ok", person };
  await tx.update(crmPeople).set({ archivedAt: new Date() }).where(eq(crmPeople.id, id));
  await appendEvent(tx, member, { personId: id }, "archived");
  return { status: "ok", person: (await loadPerson(tx, member.orgId, id))! };
}

/** Deletes for good with its addresses, deal links, notes and events. Owners and admins only. */
export async function deletePerson(tx: Ex, member: CrmMember, id: string): Promise<DeleteResult> {
  if (!member.admin) return FORBIDDEN;
  const deleted = await tx
    .delete(crmPeople)
    .where(and(eq(crmPeople.orgId, member.orgId), eq(crmPeople.id, id)))
    .returning({ id: crmPeople.id });
  return deleted.length > 0 ? { status: "ok" } : NOT_FOUND;
}
