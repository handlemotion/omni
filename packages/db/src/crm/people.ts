import { companyFromAddress, parseAddress } from "@omni/mail-core/addresses";
import { dropTasksOn } from "../calendar.ts";
import { and, asc, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { crmDealPeople, crmDeals, crmPeople, crmPersonEmails, crmStages } from "../schema/crm.ts";
import {
  companyForDomain,
  createdBetween,
  nameMatches,
  ownedBy,
  type DeleteResult,
  type InvalidName,
  type ListRecordsInput,
} from "./companies.ts";
import { listOrder, NAME_ASC, sortedPage, type CrmSortKey, type SortColumn } from "./list-order.ts";
import {
  appendEvent,
  FORBIDDEN,
  likePrefix,
  NOT_FOUND,
  pageSize,
  refuse,
  type CrmMember,
  type Ex,
  type NotFound,
} from "./core.ts";
import {
  cleanName,
  dealColumns,
  isMemberOf,
  live,
  loadCompany,
  loadPerson,
  personColumns,
  withAddresses,
  type CrmDeal,
  type CrmPerson,
} from "./records.ts";

export type InvalidAddress = { status: "invalid_address" };
export type AddressTaken = { status: "address_taken"; address: string; personId: string };

export interface ListPeopleInput extends ListRecordsInput {
  companyId?: string;
  /** Only people with a company (`true`) or without one (`false`). */
  hasCompany?: boolean;
}

export interface AddPersonInput {
  name: string;
  address: string;
  /**
   * The person's company. Null means none; left out, the company is found or made from the
   * address's domain.
   */
  companyId?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  /** Null or left out for no owner. */
  ownerMemberId?: string | null;
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
  /** Null for no owner. */
  ownerMemberId?: string | null;
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

const personSort = (key: CrmSortKey) => {
  switch (key) {
    case "created":
      return { column: crmPeople.id, cast: "text", nullable: false } satisfies SortColumn;
    case "updated":
      return {
        column: crmPeople.updatedAt,
        cast: "timestamptz",
        nullable: false,
      } satisfies SortColumn;
    default:
      return {
        column: sql`lower(${crmPeople.name})`,
        cast: "lower",
        nullable: false,
      } satisfies SortColumn;
  }
};

const personSortValue = (key: CrmSortKey) => (row: Omit<CrmPerson, "addresses">) =>
  key === "created" ? row.id : key === "updated" ? row.updatedAt : row.name;

export async function listPeople(ex: Ex, member: CrmMember, input: ListPeopleInput) {
  const limit = pageSize(input.limit);
  const sort = input.sort ?? NAME_ASC;
  const order = listOrder(sort, personSort(sort.key), crmPeople.id, input.cursor);
  const words = input.q?.trim() ? input.q : undefined;
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
  const hasCompany =
    input.hasCompany === undefined
      ? undefined
      : input.hasCompany
        ? isNotNull(crmPeople.companyId)
        : isNull(crmPeople.companyId);
  const rows = await ex
    .select(personColumns)
    .from(crmPeople)
    .where(
      and(
        eq(crmPeople.orgId, member.orgId),
        live(crmPeople.archivedAt, input.includeArchived || input.archivedOnly),
        input.archivedOnly ? isNotNull(crmPeople.archivedAt) : undefined,
        input.companyId ? eq(crmPeople.companyId, input.companyId) : undefined,
        hasCompany,
        ownedBy(crmPeople.ownerMemberId, input.ownerMemberId),
        createdBetween(crmPeople.createdAt, input),
        matches,
        order.after,
      ),
    )
    .orderBy(...order.orderBy)
    .limit(limit + 1);
  const page = sortedPage(rows, limit, sort, personSortValue(sort.key));
  return {
    status: "ok" as const,
    people: await withAddresses(ex, page.items),
    nextCursor: page.nextCursor,
  };
}

export async function getPerson(ex: Ex, member: CrmMember, id: string) {
  const person = await loadPerson(ex, member.orgId, id);
  return (person ? { status: "ok", person } : NOT_FOUND) satisfies PersonResult;
}

/** A person with the live deals they are part of. */
export async function getPersonDetail(ex: Ex, member: CrmMember, id: string) {
  const person = await loadPerson(ex, member.orgId, id);
  if (!person) return NOT_FOUND;
  const deals = await ex
    .select(dealColumns)
    .from(crmDealPeople)
    .innerJoin(crmDeals, eq(crmDeals.id, crmDealPeople.dealId))
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(and(eq(crmDealPeople.personId, id), live(crmDeals.archivedAt)))
    .orderBy(sql`lower(${crmDeals.name})`, asc(crmDeals.id));
  return { status: "ok" as const, person, deals: deals satisfies CrmDeal[] };
}

async function personWithAddress(ex: Ex, orgId: string, address: string) {
  const [row] = await ex
    .select({ personId: crmPersonEmails.personId })
    .from(crmPersonEmails)
    .where(and(eq(crmPersonEmails.orgId, orgId), eq(crmPersonEmails.address, address)));
  return row ? loadPerson(ex, orgId, row.personId) : null;
}

/**
 * Adds a person once. An address that already has a person returns that person, archived or
 * not. Otherwise the person is made and, unless the address is webmail or `companyId` is given
 * (null for none), joins the company holding its domain, made and named by `companyFromAddress` when none does.
 * Two adds of one address at once make one person: the address's unique key decides, and the
 * loser removes its own row and returns the winner's.
 */
export const addPerson: (
  tx: Ex,
  member: CrmMember,
  input: AddPersonInput,
) => Promise<AddPersonResult> = async (tx, member, input) => {
  const name = cleanName(input.name);
  if (!name) return { status: "invalid_name" };
  const address = parseAddress(input.address);
  if (!address) return { status: "invalid_address" };
  const existing = await personWithAddress(tx, member.orgId, address);
  if (existing) return { status: "ok", person: existing, created: false };

  if (input.ownerMemberId && !(await isMemberOf(tx, member.orgId, input.ownerMemberId))) {
    return NOT_FOUND;
  }
  let companyId: string | null = null;
  if (input.companyId) {
    if (!(await loadCompany(tx, member.orgId, input.companyId))) return NOT_FOUND;
    companyId = input.companyId;
  } else if (input.companyId === undefined) {
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
      ownerMemberId: input.ownerMemberId ?? null,
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
};

const normalizeAll = (list: string[] = []) => list.map((raw) => parseAddress(raw));

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

type PersonFields = Pick<CrmPerson, "name" | "companyId" | "jobTitle" | "phone" | "ownerMemberId">;

export const updatePerson: (
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: UpdatePersonInput,
) => Promise<UpdatePersonResult> = async (tx, member, id, patch) => {
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
  if (patch.ownerMemberId && !(await isMemberOf(tx, member.orgId, patch.ownerMemberId))) {
    return NOT_FOUND;
  }
  if (patch.companyId !== undefined) next.companyId = patch.companyId;
  if (patch.ownerMemberId !== undefined) next.ownerMemberId = patch.ownerMemberId;
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
    const plain = fields.filter((key) => key !== "ownerMemberId");
    if (plain.length > 0) {
      await appendEvent(tx, member, { personId: id }, "updated", { fields: plain });
    }
    if (fields.includes("ownerMemberId")) {
      await appendEvent(tx, member, { personId: id }, "owner_changed", {
        from: person.ownerMemberId,
        to: next.ownerMemberId,
      });
    }
  }
  return { status: "ok", person: (await loadPerson(tx, member.orgId, id))! };
};

export const archivePerson: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<PersonResult> = async (tx, member, id) => {
  const person = await loadPerson(tx, member.orgId, id, true);
  if (!person) return NOT_FOUND;
  if (person.archivedAt) return { status: "ok", person };
  await tx.update(crmPeople).set({ archivedAt: new Date() }).where(eq(crmPeople.id, id));
  await appendEvent(tx, member, { personId: id }, "archived");
  return { status: "ok", person: (await loadPerson(tx, member.orgId, id))! };
};

/** Brings an archived person back into every list. */
export const restorePerson: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<PersonResult> = async (tx, member, id) => {
  const person = await loadPerson(tx, member.orgId, id, true);
  if (!person) return NOT_FOUND;
  if (!person.archivedAt) return { status: "ok", person };
  await tx.update(crmPeople).set({ archivedAt: null }).where(eq(crmPeople.id, id));
  await appendEvent(tx, member, { personId: id }, "restored");
  return { status: "ok", person: (await loadPerson(tx, member.orgId, id))! };
};

/** Deletes for good with its addresses, deal links, notes and events. Owners and admins only. */
export const deletePerson: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<DeleteResult> = async (tx, member, id) => {
  if (!member.admin) return FORBIDDEN;
  const deleted = await tx
    .delete(crmPeople)
    .where(and(eq(crmPeople.orgId, member.orgId), eq(crmPeople.id, id)))
    .returning({ id: crmPeople.id });
  if (deleted.length === 0) return NOT_FOUND;
  await dropTasksOn(tx, member.orgId, "person", [id]);
  return { status: "ok" };
};
