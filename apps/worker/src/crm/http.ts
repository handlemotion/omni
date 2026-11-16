// What the CRM's route files share (ADR 0036 decision 7): the member door, the error answer for
// every refusal the door can give, the wire shapes, opaque cursors and the `crm.changed`
// announcement. Access is decided in `@omni/db` (`forMember(...).crm`); nothing here queries a
// table.
import {
  ERROR_CODES,
  type CrmChangedKind,
  type CrmCompany as WireCompany,
  type CrmContract as WireContract,
  type CrmDeal as WireDeal,
  type CrmEvent as WireEvent,
  type CrmNote as WireNote,
  type CrmPerson as WirePerson,
  type ErrorCode,
} from "@omni/contracts";
import {
  forMember,
  type AddressTaken,
  type ContractSigned,
  type CrmCompany,
  type CrmContract,
  type CrmDeal,
  type CrmEvent,
  type CrmNote,
  type CrmPerson,
  type DomainRefusal,
  type FolderResult,
  type Forbidden,
  type InvalidAddress,
  type InvalidBody,
  type InvalidContract,
  type InvalidCurrency,
  type InvalidName,
  type InvalidTransition,
  type InvalidValue,
  type NoCrm,
  type NotFound,
  type ReplaceStagesResult,
} from "@omni/db";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { ApiFailure, errorBody } from "../errors.ts";

export const memberCrm = (c: Context<AppEnv>) => forMember(c.var.db, c.var.member.id).crm;

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
  | Exclude<ReplaceStagesResult, { status: "ok" }>
  | FilesRefusal;

/** What contracts and record folders add: Storage's refusals to make a folder among them. */
type FilesRefusal =
  | ContractSigned
  | InvalidContract
  | InvalidTransition
  | Exclude<FolderResult, { status: "ok" | "not_found" | "forbidden" | "invalid_name" }>;

type Answer = { code: ErrorCode; message: string; param?: string; data?: Record<string, unknown> };

const CONTRACT_MESSAGES: Record<string, string> = {
  title: "a contract needs a title",
  dealId: "a contract is on a company, a deal or both",
  documentNodeId: "the document must be a file in Shared you can open; a signed contract needs one",
  signedAt: "only a signed contract has a signing date",
  effectiveOn: "that is not a date",
  expiresOn: "that is not a date on or after the day it takes effect",
};

function filesAnswerFor(refusal: FilesRefusal): Answer {
  switch (refusal.status) {
    case "contract_signed":
      return { code: "contract_signed", message: "a signed contract cannot change that" };
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
}

const FILES_STATUSES = new Set([
  "contract_signed",
  "invalid_transition",
  "invalid_contract",
  "too_deep",
]);
const isFilesRefusal = (refusal: CrmRefusal): refusal is FilesRefusal =>
  FILES_STATUSES.has(refusal.status);

/** The code, sentence and field of each refusal, and the ids a client acts on beside `error`. */
function answerFor(refusal: CrmRefusal): Answer {
  if (isFilesRefusal(refusal)) return filesAnswerFor(refusal);
  switch (refusal.status) {
    case "no_crm":
      return { code: "no_crm", message: "a Personal space has no CRM" };
    case "not_found":
      return { code: "not_found", message: "not found" };
    case "forbidden":
      return { code: "forbidden", message: "only owners and admins can do this" };
    case "invalid_name":
      return { code: "bad_request", message: "that name cannot be used", param: "name" };
    case "invalid_address":
      return { code: "bad_request", message: "that is not an email address", param: "address" };
    case "invalid_domain":
      return { code: "bad_request", message: "that is not a domain", param: "domain" };
    case "invalid_value":
      return {
        code: "bad_request",
        message: "the value is not a whole amount",
        param: "valueMinor",
      };
    case "invalid_body":
      return { code: "bad_request", message: "a note needs some text", param: "body" };
    case "invalid_currency":
      return { code: "invalid_currency", message: "that is not a currency", param: "currency" };
    case "webmail_domain":
      return { code: "webmail_domain", message: "a webmail domain is nobody's company" };
    case "domain_taken":
      return {
        code: "domain_taken",
        message: "another company has that domain",
        data: { companyId: refusal.companyId },
      };
    case "address_taken":
      return {
        code: "address_taken",
        message: "another person has that address",
        data: { address: refusal.address, personId: refusal.personId },
      };
    case "stage_in_use":
      return {
        code: "stage_in_use",
        message: "a stage that holds deals cannot be removed",
        data: { stageIds: refusal.stageIds },
      };
    case "stage_kind_required":
      return {
        code: "stage_kind_required",
        message: "each kind of stage needs at least one stage",
        data: { kinds: refusal.kinds },
      };
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

export const wireCompany = (company: CrmCompany): WireCompany => ({
  ...company,
  archivedAt: isoOrNull(company.archivedAt),
  createdAt: iso(company.createdAt),
  updatedAt: iso(company.updatedAt),
});

export const wirePerson = (person: CrmPerson): WirePerson => ({
  ...person,
  archivedAt: isoOrNull(person.archivedAt),
  createdAt: iso(person.createdAt),
  updatedAt: iso(person.updatedAt),
});

export const wireDeal = (deal: CrmDeal): WireDeal => ({
  ...deal,
  stageEnteredAt: iso(deal.stageEnteredAt),
  wonAt: isoOrNull(deal.wonAt),
  closedAt: isoOrNull(deal.closedAt),
  archivedAt: isoOrNull(deal.archivedAt),
  createdAt: iso(deal.createdAt),
  updatedAt: iso(deal.updatedAt),
});

export const wireContract = (contract: CrmContract): WireContract => ({
  ...contract,
  signedAt: isoOrNull(contract.signedAt),
  createdAt: iso(contract.createdAt),
  updatedAt: iso(contract.updatedAt),
});

export const wireNote = (note: CrmNote): WireNote => ({
  ...note,
  createdAt: iso(note.createdAt),
  updatedAt: iso(note.updatedAt),
});

export const wireEvent = (event: CrmEvent): WireEvent => ({
  ...event,
  createdAt: iso(event.createdAt),
});

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
