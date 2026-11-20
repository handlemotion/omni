import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  crmDealPeople,
  crmDeals,
  crmEvents,
  crmPeople,
  crmSettings,
  crmStages,
} from "../schema/crm.ts";
import {
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
  isCurrency,
  NOT_FOUND,
  pageSize,
  projectsOnly,
  type CrmMember,
  type Ex,
  type NotFound,
} from "./core.ts";
import {
  cleanName,
  dealColumns,
  dealPersonIds,
  existingPeople,
  isMemberOf,
  live,
  loadCompany,
  loadDeal,
  personColumns,
  withAddresses,
  type CrmDeal,
  type CrmPerson,
} from "./records.ts";
import { CONTRACT_SIGNED } from "./contract-status.ts";
import { holdsSignedContract } from "./contracts.ts";
import { ensureCrm, firstOpenStage, stageOf } from "./stages.ts";
import { enterFirstStage, moveDealStage, type StageKind } from "./stage-transition.ts";

export type InvalidCurrency = { status: "invalid_currency" };
/** `valueMinor` is not a whole number of minor units. */
export type InvalidValue = { status: "invalid_value" };

export interface ListDealsInput extends ListRecordsInput {
  stageId?: string;
  /** One stage kind, or any of several. */
  kind?: StageKind | readonly StageKind[];
  companyId?: string;
  /** `YYYY-MM-DD`, inclusive. */
  closeAfter?: string;
  closeBefore?: string;
  /** In minor units, inclusive. */
  minValue?: number;
  maxValue?: number;
}

export interface DealInput {
  name: string;
  companyId?: string | null;
  /** The first `open` stage when left out. */
  stageId?: string;
  /** The creating member when left out; null for no owner. */
  ownerMemberId?: string | null;
  valueMinor?: number | null;
  /** ISO 4217. The workspace's default currency when a value is given without one. */
  currency?: string | null;
  personIds?: string[];
  /** `YYYY-MM-DD`; null for none. */
  expectedCloseOn?: string | null;
}

export type DealPatch = Partial<DealInput> & {
  /**
   * A caller that may run twice (a job, a retried request) names its stage move: once an event
   * carries the key, the same patch changes nothing.
   */
  dedupeKey?: string;
};

export type DealResult = { status: "ok"; deal: CrmDeal } | NotFound;
export type DealDetailResult = { status: "ok"; deal: CrmDeal; people: CrmPerson[] } | NotFound;
export type WriteDealResult = DealResult | InvalidName | InvalidCurrency | InvalidValue;

const dealSort = (key: CrmSortKey) => {
  switch (key) {
    case "created":
      return { column: crmDeals.id, cast: "text", nullable: false } satisfies SortColumn;
    case "updated":
      return {
        column: crmDeals.updatedAt,
        cast: "timestamptz",
        nullable: false,
      } satisfies SortColumn;
    case "stageEntered":
      return {
        column: crmDeals.stageEnteredAt,
        cast: "timestamptz",
        nullable: false,
      } satisfies SortColumn;
    case "value":
      return { column: crmDeals.valueMinor, cast: "bigint", nullable: true } satisfies SortColumn;
    case "closeOn":
      return {
        column: crmDeals.expectedCloseOn,
        cast: "date",
        nullable: true,
      } satisfies SortColumn;
    default:
      return {
        column: sql`lower(${crmDeals.name})`,
        cast: "lower",
        nullable: false,
      } satisfies SortColumn;
  }
};

const dealSortValue = (key: CrmSortKey) => (row: CrmDeal) => {
  switch (key) {
    case "created":
      return row.id;
    case "updated":
      return row.updatedAt;
    case "stageEntered":
      return row.stageEnteredAt;
    case "value":
      return row.valueMinor;
    case "closeOn":
      return row.expectedCloseOn;
    default:
      return row.name;
  }
};

function kindIn(kind: ListDealsInput["kind"]) {
  if (kind === undefined) return undefined;
  const kinds: readonly StageKind[] = typeof kind === "string" ? [kind] : kind;
  return kinds.length === 0 ? undefined : inArray(crmStages.kind, [...kinds]);
}

function dealRanges(input: ListDealsInput) {
  return and(
    input.closeAfter ? gte(crmDeals.expectedCloseOn, input.closeAfter) : undefined,
    input.closeBefore ? lte(crmDeals.expectedCloseOn, input.closeBefore) : undefined,
    input.minValue === undefined ? undefined : gte(crmDeals.valueMinor, input.minValue),
    input.maxValue === undefined ? undefined : lte(crmDeals.valueMinor, input.maxValue),
  );
}

export async function listDeals(ex: Ex, member: CrmMember, input: ListDealsInput) {
  const limit = pageSize(input.limit);
  const sort = input.sort ?? NAME_ASC;
  const order = listOrder(sort, dealSort(sort.key), crmDeals.id, input.cursor);
  const rows = await ex
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(
      and(
        eq(crmDeals.orgId, member.orgId),
        projectsOnly(crmDeals.id, member),
        live(crmDeals.archivedAt, input.includeArchived || input.archivedOnly),
        input.archivedOnly ? isNotNull(crmDeals.archivedAt) : undefined,
        input.stageId ? eq(crmDeals.stageId, input.stageId) : undefined,
        kindIn(input.kind),
        ownedBy(crmDeals.ownerMemberId, input.ownerMemberId),
        input.companyId ? eq(crmDeals.companyId, input.companyId) : undefined,
        createdBetween(crmDeals.createdAt, input),
        dealRanges(input),
        nameMatches(crmDeals.name, input.q),
        order.after,
      ),
    )
    .orderBy(...order.orderBy)
    .limit(limit + 1);
  const page = sortedPage(rows, limit, sort, dealSortValue(sort.key));
  return { status: "ok" as const, deals: page.items, nextCursor: page.nextCursor };
}

async function peopleOfDeal(ex: Ex, dealId: string) {
  const rows = await ex
    .select(personColumns)
    .from(crmDealPeople)
    .innerJoin(crmPeople, eq(crmPeople.id, crmDealPeople.personId))
    .where(eq(crmDealPeople.dealId, dealId))
    .orderBy(sql`lower(${crmPeople.name})`, asc(crmPeople.id));
  return withAddresses(ex, rows);
}

export const getDeal: (ex: Ex, member: CrmMember, id: string) => Promise<DealDetailResult> = async (
  ex,
  member,
  id,
) => {
  const deal = await loadDeal(ex, member.orgId, id);
  if (!deal) return NOT_FOUND;
  return { status: "ok", deal, people: await peopleOfDeal(ex, id) };
};

async function resolveValue(
  ex: Ex,
  orgId: string,
  current: { valueMinor: number | null; valueCurrency: string | null },
  input: { valueMinor?: number | null; currency?: string | null },
) {
  const valueMinor = input.valueMinor === undefined ? current.valueMinor : input.valueMinor;
  if (valueMinor !== null && !Number.isSafeInteger(valueMinor)) {
    return { status: "invalid_value" as const };
  }
  let currency = input.currency === undefined ? current.valueCurrency : input.currency;
  if (currency !== null && !isCurrency(currency)) return { status: "invalid_currency" as const };
  if (valueMinor !== null && currency === null) {
    const [settings] = await ex
      .select({ currency: crmSettings.defaultCurrency })
      .from(crmSettings)
      .where(eq(crmSettings.orgId, orgId));
    currency = settings?.currency ?? null;
    if (currency === null) return { status: "invalid_currency" as const };
  }
  return { status: "ok" as const, valueMinor, currency };
}

async function rememberCurrency(ex: Ex, orgId: string, currency: string | null) {
  if (currency === null) return;
  await ex
    .update(crmSettings)
    .set({ defaultCurrency: currency })
    .where(
      and(
        eq(crmSettings.orgId, orgId),
        sql`${crmSettings.defaultCurrency} is distinct from ${currency}`,
      ),
    );
}

async function checkReferences(ex: Ex, member: CrmMember, input: Partial<DealInput>) {
  if (input.companyId && !(await loadCompany(ex, member.orgId, input.companyId))) return false;
  if (input.ownerMemberId && !(await isMemberOf(ex, member.orgId, input.ownerMemberId))) {
    return false;
  }
  const personIds = [...new Set(input.personIds ?? [])];
  return (await existingPeople(ex, member.orgId, personIds)).length === personIds.length;
}

export const createDeal: (
  tx: Ex,
  member: CrmMember,
  input: DealInput,
) => Promise<WriteDealResult> = async (tx, member, input) => {
  const name = cleanName(input.name);
  if (!name) return { status: "invalid_name" };
  await ensureCrm(tx, member.orgId);
  if (!(await checkReferences(tx, member, input))) return NOT_FOUND;
  const stage = input.stageId
    ? await stageOf(tx, member.orgId, input.stageId)
    : await firstOpenStage(tx, member.orgId);
  if (!stage) return NOT_FOUND;
  const value = await resolveValue(
    tx,
    member.orgId,
    { valueMinor: null, valueCurrency: null },
    input,
  );
  if (value.status !== "ok") return value;
  const state = enterFirstStage({ stageId: stage.id, kind: stage.kind }, new Date());
  const [deal] = await tx
    .insert(crmDeals)
    .values({
      orgId: member.orgId,
      name,
      companyId: input.companyId ?? null,
      stageId: state.stageId,
      stageEnteredAt: state.stageEnteredAt,
      wonAt: state.wonAt,
      closedAt: state.closedAt,
      ownerMemberId: input.ownerMemberId === undefined ? member.id : input.ownerMemberId,
      valueMinor: value.valueMinor,
      valueCurrency: value.currency,
      expectedCloseOn: input.expectedCloseOn ?? null,
      createdByMemberId: member.id,
    })
    .returning({ id: crmDeals.id });
  const personIds = [...new Set(input.personIds ?? [])];
  if (personIds.length > 0) {
    await tx
      .insert(crmDealPeople)
      .values(personIds.map((personId) => ({ orgId: member.orgId, dealId: deal!.id, personId })));
  }
  await rememberCurrency(tx, member.orgId, value.currency);
  await appendEvent(tx, member, { dealId: deal!.id }, "created", { stageId: stage.id });
  return { status: "ok", deal: (await loadDeal(tx, member.orgId, deal!.id))! };
};

async function applyMove(
  tx: Ex,
  member: CrmMember,
  deal: CrmDeal,
  target: { id: string; kind: StageKind },
  dedupeKey?: string,
) {
  const move = moveDealStage(
    { ...deal, kind: deal.stageKind },
    { stageId: target.id, kind: target.kind },
    new Date(),
  );
  if (!move.changed) return false;
  const { stageId, stageEnteredAt, wonAt, closedAt } = move.state;
  await tx
    .update(crmDeals)
    .set({ stageId, stageEnteredAt, wonAt, closedAt })
    .where(eq(crmDeals.id, deal.id));
  await appendEvent(
    tx,
    member,
    { dealId: deal.id },
    "stage_moved",
    { from: deal.stageId, to: stageId, fromKind: deal.stageKind, toKind: target.kind },
    dedupeKey,
  );
  return true;
}

async function alreadyWritten(ex: Ex, orgId: string, dedupeKey?: string) {
  if (!dedupeKey) return false;
  const [row] = await ex
    .select({ id: crmEvents.id })
    .from(crmEvents)
    .where(and(eq(crmEvents.orgId, orgId), eq(crmEvents.dedupeKey, dedupeKey)));
  return Boolean(row);
}

async function setPeople(tx: Ex, member: CrmMember, dealId: string, personIds: string[]) {
  const before = await dealPersonIds(tx, dealId);
  const wanted = [...new Set(personIds)].toSorted();
  const added = wanted.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !wanted.includes(id));
  if (added.length === 0 && removed.length === 0) return;
  if (removed.length > 0) {
    await tx
      .delete(crmDealPeople)
      .where(and(eq(crmDealPeople.dealId, dealId), inArray(crmDealPeople.personId, removed)));
  }
  if (added.length > 0) {
    await tx
      .insert(crmDealPeople)
      .values(added.map((personId) => ({ orgId: member.orgId, dealId, personId })))
      .onConflictDoNothing();
  }
  await appendEvent(tx, member, { dealId }, "people_set", { added, removed });
}

async function applyFields(
  tx: Ex,
  member: CrmMember,
  deal: CrmDeal,
  patch: DealPatch,
  value: { valueMinor: number | null; currency: string | null },
) {
  const set: Partial<typeof crmDeals.$inferInsert> = {};
  const fields: string[] = [];
  if (patch.name !== undefined && patch.name.trim() !== deal.name) {
    set.name = patch.name.trim();
    fields.push("name");
  }
  if (patch.companyId !== undefined && patch.companyId !== deal.companyId) {
    set.companyId = patch.companyId;
    fields.push("companyId");
  }
  if (patch.expectedCloseOn !== undefined && patch.expectedCloseOn !== deal.expectedCloseOn) {
    set.expectedCloseOn = patch.expectedCloseOn;
    fields.push("expectedCloseOn");
  }
  const owner = patch.ownerMemberId;
  const ownerChanged = owner !== undefined && owner !== deal.ownerMemberId;
  if (ownerChanged) set.ownerMemberId = owner;
  const valueChanged =
    value.valueMinor !== deal.valueMinor || value.currency !== deal.valueCurrency;
  if (valueChanged) {
    set.valueMinor = value.valueMinor;
    set.valueCurrency = value.currency;
  }
  if (Object.keys(set).length === 0) return;
  await tx.update(crmDeals).set(set).where(eq(crmDeals.id, deal.id));
  const record = { dealId: deal.id };
  if (fields.length > 0) await appendEvent(tx, member, record, "updated", { fields });
  if (ownerChanged) {
    await appendEvent(tx, member, record, "owner_changed", { from: deal.ownerMemberId, to: owner });
  }
  if (valueChanged) {
    await appendEvent(tx, member, record, "value_changed", {
      from: { minor: deal.valueMinor, currency: deal.valueCurrency },
      to: { minor: value.valueMinor, currency: value.currency },
    });
    await rememberCurrency(tx, member.orgId, value.currency);
  }
}

/**
 * Changes the fields `patch` names: name, company, owner, value, people, and a stage move through
 * the transition function. Each change writes its own event; an unchanged field writes none.
 */
export const updateDeal: (
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: DealPatch,
) => Promise<WriteDealResult> = async (tx, member, id, patch) => {
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  if (await alreadyWritten(tx, member.orgId, patch.dedupeKey)) return { status: "ok", deal };
  if (patch.name !== undefined && !cleanName(patch.name)) return { status: "invalid_name" };
  if (!(await checkReferences(tx, member, patch))) return NOT_FOUND;
  const target = patch.stageId ? await stageOf(tx, member.orgId, patch.stageId) : null;
  if (patch.stageId && !target) return NOT_FOUND;
  const value = await resolveValue(tx, member.orgId, deal, patch);
  if (value.status !== "ok") return value;

  if (target) await applyMove(tx, member, deal, target, patch.dedupeKey);
  await applyFields(tx, member, deal, patch, value);
  if (patch.personIds) await setPeople(tx, member, id, patch.personIds);
  return { status: "ok", deal: (await loadDeal(tx, member.orgId, id))! };
};

/** Moves several deals to one stage, each by the same rules as `updateDeal`. */
export const moveDeals: (
  tx: Ex,
  member: CrmMember,
  input: { dealIds: string[]; stageId: string },
) => Promise<{ status: "ok"; moved: string[] } | NotFound> = async (tx, member, input) => {
  const target = await stageOf(tx, member.orgId, input.stageId);
  if (!target) return NOT_FOUND;
  const deals: CrmDeal[] = [];
  for (const id of [...new Set(input.dealIds)].toSorted()) {
    const deal = await loadDeal(tx, member.orgId, id, true);
    if (!deal) return NOT_FOUND;
    deals.push(deal);
  }
  const moved: string[] = [];
  for (const deal of deals) {
    if (await applyMove(tx, member, deal, target)) moved.push(deal.id);
  }
  return { status: "ok", moved };
};

export const archiveDeal: (tx: Ex, member: CrmMember, id: string) => Promise<DealResult> = async (
  tx,
  member,
  id,
) => {
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  if (deal.archivedAt) return { status: "ok", deal };
  await tx.update(crmDeals).set({ archivedAt: new Date() }).where(eq(crmDeals.id, id));
  await appendEvent(tx, member, { dealId: id }, "archived");
  return { status: "ok", deal: (await loadDeal(tx, member.orgId, id))! };
};

/** Brings an archived deal back onto the board and into every list. */
export const restoreDeal: (tx: Ex, member: CrmMember, id: string) => Promise<DealResult> = async (
  tx,
  member,
  id,
) => {
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  if (!deal.archivedAt) return { status: "ok", deal };
  await tx.update(crmDeals).set({ archivedAt: null }).where(eq(crmDeals.id, id));
  await appendEvent(tx, member, { dealId: id }, "restored");
  return { status: "ok", deal: (await loadDeal(tx, member.orgId, id))! };
};

/** Deletes for good with its people links, notes, events and contracts. Owners and admins only. */
export const deleteDeal: (tx: Ex, member: CrmMember, id: string) => Promise<DeleteResult> = async (
  tx,
  member,
  id,
) => {
  if (!member.admin) return FORBIDDEN;
  if (await holdsSignedContract(tx, member.orgId, { dealId: id })) return CONTRACT_SIGNED;
  const deleted = await tx
    .delete(crmDeals)
    .where(and(eq(crmDeals.orgId, member.orgId), eq(crmDeals.id, id)))
    .returning({ id: crmDeals.id });
  return deleted.length > 0 ? { status: "ok" } : NOT_FOUND;
};
