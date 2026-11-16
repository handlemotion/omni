// Zod schemas of the Worker's two error shapes (ADR 0038), for code that may load zod: the
// Worker's helper and the e2e suites. Clients read errors with `toApiError` instead.
import { z } from "zod";
import { ERROR_CATEGORIES, errorCodes } from "./errors.ts";

export const errorCategorySchema = z.enum(ERROR_CATEGORIES);
export const errorCodeSchema = z.enum(errorCodes);

export const rateLimitSchema = z.object({
  remaining: z.number().int(),
  reset: z.number().int(),
  resetMs: z.number().int(),
  total: z.number().int().optional(),
});

/** The fields beside `code` and `message`, the same in both shapes. */
const extraFields = {
  requestId: z.string(),
  /** The first offending field of a validation error, as a dotted path. */
  param: z.string().optional(),
  /** `issues` for validation errors: `{ path, message, code }` each, never the input. */
  details: z.record(z.string(), z.unknown()).optional(),
  limit: rateLimitSchema.optional(),
};

/** Sent when the request carried `omni-error-format: 2`. */
export const errorBodyV2Schema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    category: errorCategorySchema,
    retryable: z.boolean(),
    ...extraFields,
  }),
});

/** A code in the legacy shape: upper case, as shipped before this format (`legacyCode`). */
export const legacyErrorCodeSchema = z
  .string()
  .refine(
    (code) => code === code.toUpperCase() && errorCodeSchema.safeParse(code.toLowerCase()).success,
  );

/** Sent otherwise: `error` is the message; the rest flat beside it. */
export const legacyErrorBodySchema = z.object({
  error: z.string(),
  code: legacyErrorCodeSchema,
  category: errorCategorySchema,
  retryable: z.boolean(),
  ...extraFields,
});

export type ErrorBodyV2 = z.infer<typeof errorBodyV2Schema>;
export type LegacyErrorBody = z.infer<typeof legacyErrorBodySchema>;
