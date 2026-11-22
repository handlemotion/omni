import { z } from "zod";
import { storageSendForSignatureBodySchema, storageSignatureStatusSchema } from "./storage.ts";

const isoDate = z.iso.datetime();
const id = z.string().min(1).max(64);
const name = z.string().max(500);
const address = z.string().min(1).max(320);
const optionalText = z.string().max(2000).nullable().optional();

/** What a stage means; the name is the workspace's. */
export const crmStageKindSchema = z.enum(["open", "won", "done", "lost"]);

export const crmCompanySchema = z.object({
  id,
  name: z.string(),
  description: z.string().nullable(),
  /** Who on the team looks after it. Optional while an older Worker may answer. */
  ownerMemberId: id.nullable().optional(),
  /** The company's folder in Shared once a file was added; use `/api/storage` on it. */
  folderNodeId: id.nullable(),
  createdByMemberId: id.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** In lists: one of its domains, for its logo. Optional while an older Worker may answer. */
  domain: z.string().nullable().optional(),
});

export const crmPersonAddressSchema = z.object({ address: z.string(), isPrimary: z.boolean() });

export const crmPersonSchema = z.object({
  id,
  name: z.string(),
  companyId: id.nullable(),
  jobTitle: z.string().nullable(),
  phone: z.string().nullable(),
  /** Who on the team looks after them. Optional while an older Worker may answer. */
  ownerMemberId: id.nullable().optional(),
  createdByMemberId: id.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** Primary first, then by address. */
  addresses: z.array(crmPersonAddressSchema),
});

export const crmDealSchema = z.object({
  id,
  name: z.string(),
  companyId: id.nullable(),
  stageId: id,
  /** The kind of the stage it is in. */
  stageKind: crmStageKindSchema,
  stageEnteredAt: isoDate,
  ownerMemberId: id.nullable(),
  /** In the currency's minor unit (cents). */
  valueMinor: z.number().int().nullable(),
  valueCurrency: z.string().nullable(),
  /** When it first entered a `won` stage. */
  wonAt: isoDate.nullable(),
  /** When it entered a `done` or `lost` stage. */
  closedAt: isoDate.nullable(),
  /** `YYYY-MM-DD`: when the team expects it to close. Optional while an older Worker may answer. */
  expectedCloseOn: z.iso.date().nullable().optional(),
  /** Its uploaded picture; null shows its client's logo. Optional while an older Worker may answer. */
  iconUrl: z.string().nullable().optional(),
  folderNodeId: id.nullable(),
  createdByMemberId: id.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const crmStageSchema = z.object({
  id,
  name: z.string(),
  kind: crmStageKindSchema,
  position: z.number().int(),
});

export const crmNoteSchema = z.object({
  id,
  companyId: id.nullable(),
  personId: id.nullable(),
  dealId: id.nullable(),
  body: z.string(),
  /** Null once the author has left the workspace. */
  authorMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const crmEventSchema = z.object({
  id,
  companyId: id.nullable(),
  personId: id.nullable(),
  dealId: id.nullable(),
  /** `created`, `stage_moved`, `owner_changed`, … A client shows the kinds it knows. */
  kind: z.string(),
  actorMemberId: id.nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
});

export const crmSettingsSchema = z.object({ defaultCurrency: z.string().nullable() });

/** `draft` → `sent` → `signed` → `ended`; `draft` may go straight to `signed`, `sent` back. */
export const crmContractStatusSchema = z.enum(["draft", "sent", "signed", "ended"]);

const day = z.iso.date();

/** One signer of a contract sent from Omni. `viewedAt` is when they first opened it. */
export const crmContractSignerSchema = z.object({
  email: z.string(),
  name: z.string(),
  viewedAt: isoDate.nullable(),
  signedAt: isoDate.nullable(),
});

/** A contract's Storage signature request, as the CRM shows it (ADR 0037). */
export const crmContractSigningSchema = z.object({
  requestId: id,
  status: storageSignatureStatusSchema,
  sentAt: isoDate,
  completedAt: isoDate.nullable(),
  voidedAt: isoDate.nullable(),
  /** The sealed copy, as soon as Storage wrote it (before the contract records it). */
  sealedNodeId: id.nullable(),
  signers: z.array(crmContractSignerSchema),
});

export const crmContractSchema = z.object({
  id,
  /** At least one of company and deal; a contract on a deal is also on its company. */
  companyId: id.nullable(),
  dealId: id.nullable(),
  title: z.string(),
  status: crmContractStatusSchema,
  /** A file in the workspace's drives, wherever it lives; use `/api/storage` on it. Locked once signed. */
  documentNodeId: id.nullable(),
  signedAt: isoDate.nullable(),
  /** `YYYY-MM-DD`. */
  effectiveOn: day.nullable(),
  expiresOn: day.nullable(),
  createdByMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** The signed copy: sealed by Omni with its certificate, or uploaded when signed elsewhere. */
  signedNodeId: id.nullable().optional(),
  /** Who signed, entered by hand when it was signed elsewhere (`POST /contracts/:id/signed-copy`). */
  signedBy: z
    .array(z.object({ name: z.string(), email: z.string().nullable() }))
    .nullable()
    .optional(),
  /** Where it is with its signers when it went out from Omni; null when sent by hand. */
  signing: crmContractSigningSchema.nullable().optional(),
  /**
   * Members it involves: teammates working it, or the freelancer it is with. A freelancer sees
   * only contracts that involve them. Absent from a Worker older than it.
   */
  memberIds: z.array(id).optional(),
});

/** A thread the viewer can open, from any of their mailboxes in the session's scope. */
export const crmThreadSchema = z.object({
  id,
  mailboxId: id,
  subject: z.string(),
  snippet: z.string(),
  lastMessageAt: isoDate,
  latestFrom: z.object({ name: z.string().nullable(), address: z.string() }).nullable(),
  /** Who the newest message went to. Optional while an older Worker may answer. */
  latestTo: z.array(z.object({ name: z.string().nullable(), address: z.string() })).optional(),
  /** Where it opens in the web app. */
  url: z.string(),
});

/**
 * A thread in a teammate's mailbox that shares its activity with the CRM,
 * which the viewer cannot open: whose mailbox, the direction of its last message and, when that
 * mailbox shares subjects, the subject. Never the thread itself.
 */
export const crmActivitySchema = z.object({
  /** A personal mailbox shows its owner's name; a shared inbox its own. */
  mailbox: z.object({ kind: z.enum(["personal", "shared"]), name: z.string() }),
  /** `out`: the last message was sent from that mailbox. */
  direction: z.enum(["in", "out"]),
  /** Null unless the mailbox shares subjects. */
  subject: z.string().nullable(),
});

const lastContactedAt = isoDate.nullable().optional();

/** How a list is ordered. Deals also take `value`, `closeOn` and `stageEntered`. */
export const crmRecordSortSchema = z.enum(["name", "created", "updated"]);
export const crmDealSortSchema = z.enum([
  "name",
  "created",
  "updated",
  "value",
  "closeOn",
  "stageEntered",
]);
export const crmSortDirSchema = z.enum(["asc", "desc"]);

const page = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  archived: z.enum(["1", "only"]).optional(),
  dir: crmSortDirSchema.optional(),
  owner: z.union([z.literal("none"), id]).optional(),
  createdAfter: isoDate.optional(),
  createdBefore: isoDate.optional(),
};
const q = z.string().max(200).optional();

/** `GET /companies`: `q` matches the start of the name or one of its words. */
export const crmCompaniesQuerySchema = z.object({
  q,
  sort: crmRecordSortSchema.optional(),
  /** Holding a domain that starts with this. */
  domain: z.string().max(253).optional(),
  ...page,
});
/** `GET /people`: `q` also matches the start of an address. */
export const crmPeopleQuerySchema = z.object({
  q,
  sort: crmRecordSortSchema.optional(),
  company: id.optional(),
  /** `1`: only people with a company; `0`: only people without one. */
  hasCompany: z.enum(["0", "1"]).optional(),
  ...page,
});
const stageKinds = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((part) => part.split(","))
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(crmStageKindSchema).min(1).max(crmStageKindSchema.options.length));

/** `GET /deals`: `stage`, `kind` (`won`, or several: `open,won`), `company`, and ranges on the close date and value. */
export const crmDealsQuerySchema = z.object({
  q,
  sort: crmDealSortSchema.optional(),
  stage: id.optional(),
  kind: stageKinds.optional(),
  company: id.optional(),
  /** `YYYY-MM-DD`, inclusive. */
  closeAfter: z.iso.date().optional(),
  closeBefore: z.iso.date().optional(),
  /** In minor units, inclusive. */
  minValue: z.coerce.number().int().optional(),
  maxValue: z.coerce.number().int().optional(),
  ...page,
});

/** `DELETE` archives; `?forever=1` deletes for good (owners and admins). */
export const crmDeleteQuerySchema = z.object({ forever: z.literal("1").optional() });

const ownerMemberId = id.nullable().optional();

export const crmCreateCompanyBodySchema = z.object({
  name,
  description: optionalText,
  domains: z.array(z.string().min(1).max(253)).max(20).optional(),
  /** The creating member when left out; null for no owner. */
  ownerMemberId,
});
/** Only the fields it names change. */
export const crmUpdateCompanyBodySchema = z.object({
  name: name.optional(),
  description: optionalText,
  ownerMemberId,
});

/** "Add once": an address that already has a person answers that person (`created: false`). */
export const crmAddPersonBodySchema = z.object({
  name,
  address,
  /** Without it, the company is found or made from the address's domain (not webmail). */
  companyId: id.optional(),
  jobTitle: optionalText,
  phone: optionalText,
  /** Null or left out for no owner. */
  ownerMemberId,
});
export const crmUpdatePersonBodySchema = z.object({
  name: name.optional(),
  /** Null leaves the person with no company. */
  companyId: id.nullable().optional(),
  jobTitle: optionalText,
  phone: optionalText,
  ownerMemberId,
  addresses: z
    .object({
      add: z.array(address).max(20).optional(),
      remove: z.array(address).max(20).optional(),
      /** One of the person's addresses after `add` and `remove`. */
      primary: address.optional(),
    })
    .optional(),
});

const dealFields = {
  companyId: id.nullable().optional(),
  stageId: id.optional(),
  ownerMemberId: id.nullable().optional(),
  valueMinor: z.number().int().nullable().optional(),
  currency: z.string().max(3).nullable().optional(),
  personIds: z.array(id).max(100).optional(),
  expectedCloseOn: z.iso.date().nullable().optional(),
};
export const crmCreateDealBodySchema = z.object({ name, ...dealFields });
export const crmUpdateDealBodySchema = z.object({ name: name.optional(), ...dealFields });

/** An existing stage keeps its kind and may be renamed; a new one names its kind. */
export const crmStageInputSchema = z.union([
  z.object({ id, name: z.string().max(200) }),
  z.object({ name: z.string().max(200), kind: crmStageKindSchema }),
]);
/** `PUT /stages`: the whole pipeline, in order (owners and admins). */
export const crmPutStagesBodySchema = z.object({ stages: z.array(crmStageInputSchema).max(50) });

export const crmPutSettingsBodySchema = z.object({
  defaultCurrency: z.string().max(3).nullable(),
});

/** `POST /notes`: on exactly one record. */
export const crmCreateNoteBodySchema = z
  .object({
    companyId: id.optional(),
    personId: id.optional(),
    dealId: id.optional(),
    body: z.string().max(20_000),
  })
  .refine((note) => [note.companyId, note.personId, note.dealId].filter(Boolean).length === 1, {
    message: "give exactly one of companyId, personId and dealId",
  });
export const crmUpdateNoteBodySchema = z.object({ body: z.string().max(20_000) });

/** `GET /contracts?company=|deal=`: newest first. A company's include those on its deals. */
export const crmContractsQuerySchema = z
  .object({
    company: id.optional(),
    deal: id.optional(),
    cursor: page.cursor,
    limit: page.limit,
  })
  .refine((query) => Boolean(query.company) !== Boolean(query.deal), {
    message: "give exactly one of company and deal",
  });

/** `POST /contracts`: a draft. Without `companyId`, it is on the deal's company too. */
export const crmCreateContractBodySchema = z
  .object({
    title: name,
    companyId: id.optional(),
    dealId: id.optional(),
    /** A file in the workspace's drives (not My files), referenced where it lives. */
    documentNodeId: id.nullable().optional(),
    effectiveOn: day.nullable().optional(),
    expiresOn: day.nullable().optional(),
    /** Members of the workspace it involves. */
    memberIds: z.array(id).max(20).optional(),
  })
  .refine((contract) => Boolean(contract.companyId || contract.dealId), {
    message: "give a companyId, a dealId or both",
  });

/**
 * `PATCH /contracts/:id`: only the fields it names. Marking it `signed` needs a document and
 * locks that file; a signed contract keeps its status and document (`contract_signed`).
 */
export const crmUpdateContractBodySchema = z.object({
  title: name.optional(),
  status: crmContractStatusSchema.optional(),
  /** Replaced while `draft`, or when a `sent` contract is marked signed (the executed copy). */
  documentNodeId: id.nullable().optional(),
  /** When it was signed; now when a contract is marked signed without one. */
  signedAt: isoDate.optional(),
  effectiveOn: day.nullable().optional(),
  expiresOn: day.nullable().optional(),
  /** Replaces the members it involves. */
  memberIds: z.array(id).max(20).optional(),
});

/**
 * `POST /contracts/:id/signed-copy`: signed outside Omni (a client's portal, paper, another
 * service). The executed PDF becomes the signed copy, locked, with who signed and when; a draft or
 * a contract sent by hand becomes `signed`, and one marked signed without its copy takes it. A
 * contract out for signature from Omni answers `signature_open`; one with its copy, `contract_signed`.
 */
export const crmSignedCopyBodySchema = z.object({
  /** The executed copy: a PDF in the workspace's drives, uploaded or already there. */
  nodeId: id,
  /** When it was signed; now when left out. */
  signedAt: isoDate.optional(),
  signers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        email: z.email().max(320).nullable().optional(),
      }),
    )
    .max(20),
});

/**
 * `POST /contracts/:id/send`: a draft whose document is a PDF goes out for signature. Each signer
 * gets a link, signs with a code mailed to them, and once all signed the contract is `signed`
 * with a sealed copy beside the document. `POST /contracts/:id/void` takes it back to `draft`.
 */
export const crmSendContractBodySchema = storageSendForSignatureBodySchema;

/** `GET /:records/:id/timeline`. */
export const crmTimelineQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Up to 50 addresses, as `?address=a&address=b` or `?address=a,b`. */
export const CRM_LOOKUP_MAX_ADDRESSES = 50;
export const crmLookupQuerySchema = z.object({
  address: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : [value])
        .flatMap((part) => part.split(","))
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(address).min(1).max(CRM_LOOKUP_MAX_ADDRESSES)),
});
export const crmSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const crmCompanyListResponseSchema = z.object({
  companies: z.array(crmCompanySchema),
  nextCursor: z.string().nullable(),
});
export const crmCompanyResponseSchema = z.object({ company: crmCompanySchema });
/** `GET /companies/:id`: with its domains, live people and live deals. */
export const crmCompanyDetailResponseSchema = z.object({
  company: crmCompanySchema,
  domains: z.array(z.string()),
  people: z.array(crmPersonSchema),
  deals: z.array(crmDealSchema),
  lastContactedAt,
});
export const crmDomainsResponseSchema = z.object({ domains: z.array(z.string()) });

export const crmPersonListResponseSchema = z.object({
  people: z.array(crmPersonSchema),
  nextCursor: z.string().nullable(),
});
export const crmPersonResponseSchema = z.object({ person: crmPersonSchema });
/** `GET /people/:id`: with the live deals they are part of. */
export const crmPersonDetailResponseSchema = crmPersonResponseSchema.extend({
  lastContactedAt,
  /** Optional while an older Worker may answer. */
  deals: z.array(crmDealSchema).optional(),
});

/** `POST /companies/bulk`, `/people/bulk`, `/deals/bulk`: one action on up to 200 records. */
export const crmBulkBodySchema = z.object({
  ids: z.array(id).min(1).max(200),
  action: z.discriminatedUnion("action", [
    z.object({ action: z.literal("archive") }),
    z.object({ action: z.literal("restore") }),
    z.object({ action: z.literal("delete") }),
    z.object({ action: z.literal("owner"), ownerMemberId: id.nullable() }),
    z.object({ action: z.literal("stage"), stageId: id }),
  ]),
});
/** What changed, and what was refused with the code the single route would answer. */
export const crmBulkResponseSchema = z.object({
  done: z.array(id),
  refused: z.array(z.object({ id, code: z.string() })),
});
/** `POST /people`: 201 when made, 200 with `created: false` when the address had a person. */
export const crmAddPersonResponseSchema = z.object({
  person: crmPersonSchema,
  created: z.boolean(),
});

export const crmDealListResponseSchema = z.object({
  deals: z.array(crmDealSchema),
  nextCursor: z.string().nullable(),
});
export const crmDealResponseSchema = z.object({ deal: crmDealSchema });
/** `GET /deals/:id`: with its people and its newest contracts (all of them on `/contracts`). */
export const crmDealDetailResponseSchema = z.object({
  deal: crmDealSchema,
  people: z.array(crmPersonSchema),
  contracts: z.array(crmContractSchema),
  lastContactedAt,
});

export const crmContractResponseSchema = z.object({ contract: crmContractSchema });
export const crmContractListResponseSchema = z.object({
  contracts: z.array(crmContractSchema),
  nextCursor: z.string().nullable(),
});
/** `POST /companies/:id/folder` and `POST /deals/:id/folder`: use `/api/storage` on it. */
export const crmFolderResponseSchema = z.object({ nodeId: id });

export const crmStagesResponseSchema = z.object({ stages: z.array(crmStageSchema) });
export const crmSettingsResponseSchema = z.object({ settings: crmSettingsSchema });
export const crmNoteResponseSchema = z.object({ note: crmNoteSchema });

/** People, companies and deals: `GET /search` and `GET /lookup` (open and won deals only). */
export const crmFoundResponseSchema = z.object({
  people: z.array(crmPersonSchema),
  companies: z.array(crmCompanySchema),
  deals: z.array(crmDealSchema),
});

const timelineItem = { id, at: isoDate };
export const crmTimelineEventItemSchema = z.object({
  kind: z.literal("event"),
  ...timelineItem,
  event: crmEventSchema,
});
export const crmTimelineNoteItemSchema = z.object({
  kind: z.literal("note"),
  ...timelineItem,
  note: crmNoteSchema,
});
export const crmTimelineThreadItemSchema = z.object({
  kind: z.literal("thread"),
  ...timelineItem,
  thread: crmThreadSchema,
});
/** A contract's own events, which are not repeated as `event` items. */
export const crmTimelineContractItemSchema = z.object({
  kind: z.literal("contract"),
  ...timelineItem,
  contract: z.object({
    contractId: id,
    /** The title when it happened. */
    title: z.string(),
    /** `status`: it moved to `status` (sent, signed, ended, back to draft). */
    change: z.enum(["created", "status", "document", "deleted"]),
    /** Its status after the change. */
    status: crmContractStatusSchema,
    actorMemberId: id.nullable(),
  }),
});
/** Shared activity: `id` is opaque and stable, never a thread id. */
export const crmTimelineActivityItemSchema = z.object({
  kind: z.literal("activity"),
  ...timelineItem,
  activity: crmActivitySchema,
});
export const crmTimelineItemSchema = z.discriminatedUnion("kind", [
  crmTimelineEventItemSchema,
  crmTimelineNoteItemSchema,
  crmTimelineContractItemSchema,
  crmTimelineThreadItemSchema,
  crmTimelineActivityItemSchema,
]);
export const crmTimelineResponseSchema = z.object({
  items: z.array(crmTimelineItemSchema),
  nextCursor: z.string().nullable(),
});

/** What changed, on the workspace's realtime socket. Ids only: a client refetches. */
export const crmChangedKindSchema = z.enum([
  "company",
  "person",
  "deal",
  "note",
  "stages",
  "settings",
  "contract",
  "task",
]);
export const crmChangedEventSchema = z.object({
  type: z.literal("crm.changed"),
  kind: crmChangedKindSchema,
  ids: z.array(id),
});

export type CrmStageKind = z.infer<typeof crmStageKindSchema>;
export type CrmCompany = z.infer<typeof crmCompanySchema>;
export type CrmPerson = z.infer<typeof crmPersonSchema>;
export type CrmDeal = z.infer<typeof crmDealSchema>;
export type CrmStage = z.infer<typeof crmStageSchema>;
export type CrmNote = z.infer<typeof crmNoteSchema>;
export type CrmEvent = z.infer<typeof crmEventSchema>;
export type CrmSettings = z.infer<typeof crmSettingsSchema>;
export type CrmContractStatus = z.infer<typeof crmContractStatusSchema>;
export type CrmContract = z.infer<typeof crmContractSchema>;
export type CrmCreateContractBody = z.infer<typeof crmCreateContractBodySchema>;
export type CrmUpdateContractBody = z.infer<typeof crmUpdateContractBodySchema>;
export type CrmSendContractBody = z.infer<typeof crmSendContractBodySchema>;
export type CrmSignedCopyBody = z.infer<typeof crmSignedCopyBodySchema>;
export type CrmContractSigner = z.infer<typeof crmContractSignerSchema>;
export type CrmContractSigning = z.infer<typeof crmContractSigningSchema>;
export type CrmContractResponse = z.infer<typeof crmContractResponseSchema>;
export type CrmContractListResponse = z.infer<typeof crmContractListResponseSchema>;
export type CrmFolderResponse = z.infer<typeof crmFolderResponseSchema>;
export type CrmThread = z.infer<typeof crmThreadSchema>;
export type CrmCreateCompanyBody = z.infer<typeof crmCreateCompanyBodySchema>;
export type CrmUpdateCompanyBody = z.infer<typeof crmUpdateCompanyBodySchema>;
export type CrmAddPersonBody = z.infer<typeof crmAddPersonBodySchema>;
export type CrmUpdatePersonBody = z.infer<typeof crmUpdatePersonBodySchema>;
export type CrmCreateDealBody = z.infer<typeof crmCreateDealBodySchema>;
export type CrmUpdateDealBody = z.infer<typeof crmUpdateDealBodySchema>;
export type CrmStageInput = z.infer<typeof crmStageInputSchema>;
export type CrmPutStagesBody = z.infer<typeof crmPutStagesBodySchema>;
export type CrmPutSettingsBody = z.infer<typeof crmPutSettingsBodySchema>;
export type CrmCreateNoteBody = z.infer<typeof crmCreateNoteBodySchema>;
export type CrmCompanyListResponse = z.infer<typeof crmCompanyListResponseSchema>;
export type CrmCompanyResponse = z.infer<typeof crmCompanyResponseSchema>;
export type CrmCompanyDetailResponse = z.infer<typeof crmCompanyDetailResponseSchema>;
export type CrmDomainsResponse = z.infer<typeof crmDomainsResponseSchema>;
export type CrmPersonListResponse = z.infer<typeof crmPersonListResponseSchema>;
export type CrmPersonResponse = z.infer<typeof crmPersonResponseSchema>;
export type CrmPersonDetailResponse = z.infer<typeof crmPersonDetailResponseSchema>;
export type CrmActivity = z.infer<typeof crmActivitySchema>;
export type CrmAddPersonResponse = z.infer<typeof crmAddPersonResponseSchema>;
export type CrmDealListResponse = z.infer<typeof crmDealListResponseSchema>;
export type CrmDealResponse = z.infer<typeof crmDealResponseSchema>;
export type CrmDealDetailResponse = z.infer<typeof crmDealDetailResponseSchema>;
export type CrmStagesResponse = z.infer<typeof crmStagesResponseSchema>;
export type CrmSettingsResponse = z.infer<typeof crmSettingsResponseSchema>;
export type CrmNoteResponse = z.infer<typeof crmNoteResponseSchema>;
export type CrmFoundResponse = z.infer<typeof crmFoundResponseSchema>;
export type CrmTimelineItem = z.infer<typeof crmTimelineItemSchema>;
export type CrmTimelineResponse = z.infer<typeof crmTimelineResponseSchema>;
export type CrmChangedKind = z.infer<typeof crmChangedKindSchema>;
export type CrmChangedEvent = z.infer<typeof crmChangedEventSchema>;
export type CrmRecordSort = z.infer<typeof crmRecordSortSchema>;
export type CrmDealSort = z.infer<typeof crmDealSortSchema>;
export type CrmSortDir = z.infer<typeof crmSortDirSchema>;
export type CrmBulkBody = z.infer<typeof crmBulkBodySchema>;
export type CrmBulkResponse = z.infer<typeof crmBulkResponseSchema>;
