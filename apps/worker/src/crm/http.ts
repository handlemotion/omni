import {
  ERROR_CODES,
  type CrmChangedKind,
  type CrmCompany as WireCompany,
  type CrmContract as WireContract,
  type CrmDeal as WireDeal,
  type CrmEvent as WireEvent,
  type CrmNote as WireNote,
  type CrmPerson as WirePerson,
  type CrmTask as WireTask,
  type ErrorCode,
} from "@omni/contracts";
import {
  forMember,
  type MemberCrm,
  type AddressTaken,
  type ContractSigned,
  type CrmCompany,
  type CrmContract,
  type CrmDeal,
  type CrmEvent,
  type CrmNote,
  type CrmListCursor,
  type CrmPerson,
  type CrmSortKey,
  type CrmTask,
  type DomainRefusal,
  type ListRecordsInput,
  type FolderResult,
  type Forbidden,
  type InvalidAddress,
  type InvalidAssignee,
  type InvalidBody,
  type InvalidContract,
  type InvalidCurrency,
  type InvalidName,
  type InvalidTitle,
  type InvalidTransition,
  type InvalidValue,
  type NoCrm,
  type NotFound,
  type ReplaceStagesResult,
  type SignatureOpen,
} from "@omni/db";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { ApiFailure, errorBody } from "../errors.ts";

export const memberCrm: (c: Context<AppEnv>) => MemberCrm = (c) =>
  forMember(c.var.db, c.var.member.id).crm;

/** Every refusal a CRM door operation can answer. */
export type CrmRefusal =
  | NoCrm
  | NotFound
  | Forbidden
  | InvalidName
  | InvalidAddress
  | InvalidBody
  | InvalidCurrency
  | InvalidValue
  | DomainRefusal
  | AddressTaken
  | InvalidTitle
  | InvalidAssignee
  | Exclude<ReplaceStagesResult, { status: "ok" }>
  | FilesRefusal
  | PlanRefusal;

/** What a project's plan and access add. */
type PlanRefusal =
  | { status: "invalid_milestone" }
  | { status: "invalid_file" }
  | { status: "plan_full" }
  | { status: "invalid_email" }
  | { status: "already_teammate" }
  | { status: "too_many" }
  | { status: "sharing_refused"; reason: string };

/** What contracts and record folders add: Storage's refusals to make a folder among them. */
type FilesRefusal =
  | ContractSigned
  | SignatureOpen
  | InvalidContract
  | InvalidTransition
  | Exclude<FolderResult, { status: "ok" | "not_found" | "forbidden" | "invalid_name" }>;

type Answer = { code: ErrorCode; message: string; param?: string; data?: Record<string, unknown> };

const CONTRACT_MESSAGES: Record<string, string> = {
  title: "a contract needs a title",
  dealId: "a contract is on a company, a deal or both",
  documentNodeId: "the document must be a file in Shared you can open; a signed contract needs one",
  signedAt: "only a signed contract has a signing date, and it is not in the future",
  nodeId: "the signed copy must be a PDF in Shared you can open",
  signers: "each signer needs a name",
  effectiveOn: "that is not a date",
  expiresOn: "that is not a date on or after the day it takes effect",
};

const filesAnswerFor: (refusal: FilesRefusal) => Answer = (refusal) => {
  switch (refusal.status) {
    case "contract_signed":
      return { code: "contract_signed", message: "a signed contract cannot change that" };
    case "signature_open":
      return {
        code: "signature_open",
        message: "this contract is out for signature: void it first",
      };
    case "invalid_transition":
      return {
        code: "conflict",
        message:
          refusal.from === "sent" && refusal.to === "sent"
            ? "a sent contract keeps its document; move it back to draft to replace it"
            : `a contract cannot go from ${refusal.from} to ${refusal.to}`,
        data: { from: refusal.from, to: refusal.to },
      };
    case "invalid_contract":
      return {
        code: "bad_request",
        message: CONTRACT_MESSAGES[refusal.param] ?? "that cannot be stored",
        param: refusal.param,
      };
    case "too_deep":
      return { code: "too_deep", message: "the record's folder would be too deep in Shared" };
  }
};

const FILES_STATUSES = new Set([
  "contract_signed",
  "signature_open",
  "invalid_transition",
  "invalid_contract",
  "too_deep",
]);
const isFilesRefusal = (refusal: CrmRefusal): refusal is FilesRefusal =>
  FILES_STATUSES.has(refusal.status);

const PLAN_ANSWERS: Record<PlanRefusal["status"], Answer> = {
  invalid_milestone: {
    code: "bad_request",
    message: "that milestone is not on this deal",
    param: "milestoneId",
  },
  invalid_file: {
    code: "bad_request",
    message: "that is not a file you can open",
    param: "nodeId",
  },
  plan_full: { code: "conflict", message: "a project holds at most 200 of these" },
  invalid_email: { code: "invalid_email", message: "that is not an email address", param: "email" },
  already_teammate: {
    code: "conflict",
    message: "that address is a teammate's, who already sees every project",
  },
  too_many: { code: "conflict", message: "a project has at most 50 people from outside the team" },
  sharing_refused: {
    code: "sharing_policy",
    message: "Drive would not share the project's folder with that address",
  },
};
const PLAN_STATUSES = new Set<string>(Object.keys(PLAN_ANSWERS));
const isPlanRefusal = (refusal: CrmRefusal): refusal is PlanRefusal =>
  PLAN_STATUSES.has(refusal.status);

function answerFor(refusal: CrmRefusal) {
  if (isFilesRefusal(refusal)) return filesAnswerFor(refusal) satisfies Answer;
  if (isPlanRefusal(refusal)) return PLAN_ANSWERS[refusal.status];
  switch (refusal.status) {
    case "no_crm":
      return { code: "no_crm", message: "a Personal space has no CRM" } satisfies Answer;
    case "not_found":
      return { code: "not_found", message: "not found" } satisfies Answer;
    case "forbidden":
      return { code: "forbidden", message: "only owners and admins can do this" } satisfies Answer;
    case "invalid_name":
      return {
        code: "bad_request",
        message: "that name cannot be used",
        param: "name",
      } satisfies Answer;
    case "invalid_address":
      return {
        code: "bad_request",
        message: "that is not an email address",
        param: "address",
      } satisfies Answer;
    case "invalid_domain":
      return {
        code: "bad_request",
        message: "that is not a domain",
        param: "domain",
      } satisfies Answer;
    case "invalid_value":
      return {
        code: "bad_request",
        message: "the value is not a whole amount",
        param: "valueMinor",
      } satisfies Answer;
    case "invalid_body":
      return {
        code: "bad_request",
        message: "a note needs some text",
        param: "body",
      } satisfies Answer;
    case "invalid_title":
      return {
        code: "bad_request",
        message: "a task needs a title",
        param: "title",
      } satisfies Answer;
    case "invalid_assignee":
      return {
        code: "bad_request",
        message: "the assignee is not a member of this workspace",
        param: "assigneeMemberId",
      } satisfies Answer;
    case "invalid_currency":
      return {
        code: "invalid_currency",
        message: "that is not a currency",
        param: "currency",
      } satisfies Answer;
    case "webmail_domain":
      return {
        code: "webmail_domain",
        message: "a webmail domain is nobody's company",
      } satisfies Answer;
    case "domain_taken":
      return {
        code: "domain_taken",
        message: "another company has that domain",
        data: { companyId: refusal.companyId },
      } satisfies Answer;
    case "address_taken":
      return {
        code: "address_taken",
        message: "another person has that address",
        data: { address: refusal.address, personId: refusal.personId },
      } satisfies Answer;
    case "stage_in_use":
      return {
        code: "stage_in_use",
        message: "a stage that holds deals cannot be removed",
        data: { stageIds: refusal.stageIds },
      } satisfies Answer;
    case "stage_kind_required":
      return {
        code: "stage_kind_required",
        message: "each kind of stage needs at least one stage",
        data: { kinds: refusal.kinds },
      } satisfies Answer;
  }
}

/** The API's answer for a refusal of the CRM door: its code, and data beside `error`. */
export function refused(c: Context<AppEnv>, refusal: CrmRefusal) {
  const { code, message, param, data } = answerFor(refusal);
  const body = errorBody(c, code, message, param === undefined ? {} : { param });
  return c.json({ ...body, ...data }, ERROR_CODES[code].status);
}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

export const wireCompany = (company: CrmCompany) => {
  const result: WireCompany = {
    ...company,
    archivedAt: isoOrNull(company.archivedAt),
    createdAt: iso(company.createdAt),
    updatedAt: iso(company.updatedAt),
  };
  return result;
};

export const wirePerson = (person: CrmPerson) =>
  ({
    ...person,
    archivedAt: isoOrNull(person.archivedAt),
    createdAt: iso(person.createdAt),
    updatedAt: iso(person.updatedAt),
  }) satisfies WirePerson;

export const dealIconUrl = (dealId: string, iconId: string) =>
  `/api/crm/deals/${dealId}/icon/${iconId}`;

export const wireDeal = ({ iconId, ...deal }: CrmDeal) =>
  ({
    ...deal,
    iconUrl: iconId ? dealIconUrl(deal.id, iconId) : null,
    stageEnteredAt: iso(deal.stageEnteredAt),
    wonAt: isoOrNull(deal.wonAt),
    closedAt: isoOrNull(deal.closedAt),
    archivedAt: isoOrNull(deal.archivedAt),
    createdAt: iso(deal.createdAt),
    updatedAt: iso(deal.updatedAt),
  }) satisfies WireDeal;

const wireSigning = (signing: CrmContract["signing"]) =>
  signing && {
    ...signing,
    sentAt: iso(signing.sentAt),
    completedAt: isoOrNull(signing.completedAt),
    voidedAt: isoOrNull(signing.voidedAt),
    signers: signing.signers.map((signer) => ({
      ...signer,
      viewedAt: isoOrNull(signer.viewedAt),
      signedAt: isoOrNull(signer.signedAt),
    })),
  };

export const wireContract = ({ signatureRequestId: _request, ...contract }: CrmContract) =>
  ({
    ...contract,
    signing: wireSigning(contract.signing),
    signedAt: isoOrNull(contract.signedAt),
    createdAt: iso(contract.createdAt),
    updatedAt: iso(contract.updatedAt),
  }) satisfies WireContract;

export const wireNote = (note: CrmNote) =>
  ({
    ...note,
    createdAt: iso(note.createdAt),
    updatedAt: iso(note.updatedAt),
  }) satisfies WireNote;

export const wireTask = (task: CrmTask) =>
  ({
    ...task,
    dueAt: isoOrNull(task.dueAt),
    completedAt: isoOrNull(task.completedAt),
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  }) satisfies WireTask;

export const wireEvent = (event: CrmEvent) =>
  ({
    ...event,
    createdAt: iso(event.createdAt),
  }) satisfies WireEvent;

/** A cursor travels as base64url JSON: opaque to the client, checked on the way back in. */
export function encodeCursor(cursor: unknown) {
  if (!cursor) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor<T extends z.ZodType>(value: string | undefined, schema: T) {
  if (value === undefined) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return schema.parse(JSON.parse(json)) as z.output<T>;
  } catch {
    throw new ApiFailure("bad_request", "invalid cursor", { param: "cursor" });
  }
}

/** A list by name: the last row's name and id. */
export const nameCursor = z.object({ name: z.string(), id: z.string().min(1) });

const sortKey = z.enum(["name", "created", "updated", "value", "closeOn", "stageEntered"]);

/**
 * Where a list page ended: its sort, the last row's sort value and id. A cursor an
 * older Worker gave (by name) reads as a name cursor, so an open tab keeps paging.
 */
export const listCursor = z.union([
  z.object({
    key: sortKey,
    dir: z.enum(["asc", "desc"]),
    value: z.string().nullable(),
    id: z.string().min(1),
  }),
  nameCursor.transform(
    ({ name, id }) => ({ key: "name", dir: "asc", value: name, id }) satisfies CrmListCursor,
  ),
]);

/** What every list query shares, as the CRM door takes it. */
export function listInput(query: {
  q?: string;
  sort?: CrmSortKey;
  dir?: "asc" | "desc";
  cursor?: string;
  limit?: number;
  archived?: "1" | "only";
  owner?: string;
  createdAfter?: string;
  createdBefore?: string;
}) {
  return {
    q: query.q,
    sort: { key: query.sort ?? "name", dir: query.dir ?? "asc" },
    cursor: decodeCursor(query.cursor, listCursor),
    limit: query.limit,
    includeArchived: query.archived === "1",
    archivedOnly: query.archived === "only",
    ownerMemberId: query.owner === "none" ? null : query.owner,
    createdAfter: query.createdAfter ? new Date(query.createdAfter) : undefined,
    createdBefore: query.createdBefore ? new Date(query.createdBefore) : undefined,
  } satisfies ListRecordsInput;
}

/** The error code the single route would answer for a refusal, for a bulk answer. */
export const refusalCode = (status: string) =>
  ((answerFor({ status } as CrmRefusal) as Answer | undefined)?.code ??
    "conflict") satisfies ErrorCode;

/**
 * Tells the workspace's members what changed (`crm.changed`, ids only): every member sees every
 * record. The audience is read now, as mail's fan-out reads a mailbox's, so a member removed
 * after connecting hears nothing. Sent after the response, so a socket that is down never fails
 * the write.
 */
export async function announce(c: Context<AppEnv>, kind: CrmChangedKind, ids: (string | null)[]) {
  const changed = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (changed.length === 0) return;
  const audience = await memberCrm(c).audience();
  if (audience.status !== "ok" || audience.memberIds.length === 0) return;
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.var.member.orgId));
  c.executionCtx.waitUntil(
    stub
      .broadcast(audience.memberIds, { type: "crm.changed", kind, ids: changed })
      .catch((error: unknown) => c.var.log.warn("crm.announce_failed", { error })),
  );
}
