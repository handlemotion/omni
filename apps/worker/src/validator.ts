// Request validation for every route. A failure answers 400 `bad_request` through `apiError`
// (errors.ts, ADR 0038) instead of @hono/zod-validator's default body (the raw Zod error), which
// clients cannot show: the sentence, `param` (the first offending field) and `details.issues`.
// Import `zValidator` from here, not from the library.
import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { Context, ValidationTargets } from "hono";
import type { core, output, ZodType } from "zod";
import { ApiFailure } from "./errors.ts";

/** Paths, codes and expectations only: Zod's issue messages never quote the input. */
function invalid(what: string, issues: readonly core.$ZodIssue[], message?: string) {
  const first = issues.find((issue) => issue.path.length > 0);
  const param = first?.path.join(".");
  const lines = issues.map((issue) =>
    issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
  return new ApiFailure("bad_request", message ?? `invalid ${what}: ${lines.join("; ")}`, {
    ...(param !== undefined && { param }),
    details: {
      issues: issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: issue.message,
      })),
    },
  });
}

export function zValidator<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
  /** Shown instead of the issues, when they would not help the person who sees it. */
  message?: string,
) {
  return honoZValidator(target, schema, (result) => {
    if (result.success) return;
    throw invalid(target, result.error.issues, message);
  });
}

/**
 * An optional JSON body, for a route that took none before. Read by hand rather than with
 * `zValidator("json")` so the typed client keeps calling it without one: an empty body is `{}`,
 * and older clients that send nothing behave as they always did.
 */
export async function optionalJsonBody<T extends ZodType>(c: Context, schema: T) {
  const text = await c.req.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiFailure("bad_request", "Malformed JSON in request body");
    }
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data satisfies output<T>;
  throw invalid("json", parsed.error.issues);
}
