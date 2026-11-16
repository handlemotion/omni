// Deals: the pipeline's records. A won deal is the project (ADR 0036), so one record goes from
// lead to delivered. Stage moves go through `moveDealStage`, the one transition function.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { members } from "../schema/auth.ts";
import {
  crmDealPeople,
  crmDeals,
  crmEvents,
  crmPeople,
  crmSettings,
  crmStages,
} from "../schema/crm.ts";
import { nameMatches, type DeleteResult, type InvalidName } from "./companies.ts";
import {
  afterName,
  appendEvent,
  FORBIDDEN,
  isCurrency,
  namePage,
  NOT_FOUND,
  pageSize,
  type CrmMember,
  type CrmNameCursor,
  type Ex,
  type NotFound,
} from "./core.ts";
import {
  cleanName,
  dealColumns,
  dealPersonIds,
  existingPeople,
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

export interface ListDealsInput {
  q?: string;
  stageId?: string;
  kind?: StageKind;
  ownerMemberId?: string;
  companyId?: string;
  cursor?: CrmNameCursor | null;
  limit?: number;
  includeArchived?: boolean;
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

export async function listDeals(ex: Ex, member: CrmMember, input: ListDealsInput) {
  const limit = pageSize(input.limit);
  const rows = await ex
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(
      and(
        eq(crmDeals.orgId, member.orgId),
        live(crmDeals.archivedAt, input.includeArchived),
        input.stageId ? eq(crmDeals.stageId, input.stageId) : undefined,
        input.kind ? eq(crmStages.kind, input.kind) : undefined,
        input.ownerMemberId ? eq(crmDeals.ownerMemberId, input.ownerMemberId) : undefined,
        input.companyId ? eq(crmDeals.companyId, input.companyId) : undefined,
        nameMatches(crmDeals.name, input.q),
        afterName(crmDeals.name, crmDeals.id, input.cursor),
      ),
    )
    .orderBy(sql`lower(${crmDeals.name})`, asc(crmDeals.id))
    .limit(limit + 1);
  const page = namePage(rows, limit);
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

export async function getDeal(ex: Ex, member: CrmMember, id: string): Promise<DealDetailResult> {
  const deal = await loadDeal(ex, member.orgId, id);
  if (!deal) return NOT_FOUND;
  return { status: "ok", deal, people: await peopleOfDeal(ex, id) };
}

async function isMemberOf(ex: Ex, orgId: string, memberId: string) {
  const [row] = await ex
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.organizationId, orgId)));
  return Boolean(row);
}

/** The value and currency a write leaves, or why not. The default fills a missing currency. */
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

/** The last currency a workspace used becomes its default. */
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

/** Checks the references a deal write names: company, stage, owner and people. */
async function checkReferences(ex: Ex, member: CrmMember, input: Partial<DealInput>) {
  if (input.companyId && !(await loadCompany(ex, member.orgId, input.companyId))) return false;
  if (input.ownerMemberId && !(await isMemberOf(ex, member.orgId, input.ownerMemberId))) {
    return false;
  }
  const personIds = [...new Set(input.personIds ?? [])];
  return (await existingPeople(ex, member.orgId, personIds)).length === personIds.length;
}

export async function createDeal(
  tx: Ex,
  member: CrmMember,
  input: DealInput,
): Promise<WriteDealResult> {
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
}

/** Moves one locked deal; writes the change and its event, or nothing when it is a repeat. */
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

/** Sets the deal's people to exactly `personIds`; writes `people_set` when that changed them. */
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

/** Writes name and company, owner, and value changes with one event each. */
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
export async function updateDeal(
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: DealPatch,
): Promise<WriteDealResult> {
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
}

/** Moves several deals to one stage, each by the same rules as `updateDeal`. */
export async function moveDeals(
  tx: Ex,
  member: CrmMember,
  input: { dealIds: string[]; stageId: string },
): Promise<{ status: "ok"; moved: string[] } | NotFound> {
  const target = await stageOf(tx, member.orgId, input.stageId);
  if (!target) return NOT_FOUND;
  // Every deal is found and locked before any moves, so a missing id changes nothing.
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
}

export async function archiveDeal(tx: Ex, member: CrmMember, id: string): Promise<DealResult> {
  const deal = await loadDeal(tx, member.orgId, id, true);
  if (!deal) return NOT_FOUND;
  if (deal.archivedAt) return { status: "ok", deal };
  await tx.update(crmDeals).set({ archivedAt: new Date() }).where(eq(crmDeals.id, id));
  await appendEvent(tx, member, { dealId: id }, "archived");
  return { status: "ok", deal: (await loadDeal(tx, member.orgId, id))! };
}

/** Deletes for good with its people links, notes, events and contracts. Owners and admins only. */
export async function deleteDeal(tx: Ex, member: CrmMember, id: string): Promise<DeleteResult> {
  if (!member.admin) return FORBIDDEN;
  if (await holdsSignedContract(tx, member.orgId, { dealId: id })) return CONTRACT_SIGNED;
  const deleted = await tx
    .delete(crmDeals)
    .where(and(eq(crmDeals.orgId, member.orgId), eq(crmDeals.id, id)))
    .returning({ id: crmDeals.id });
  return deleted.length > 0 ? { status: "ok" } : NOT_FOUND;
}
