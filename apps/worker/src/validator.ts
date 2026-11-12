// Request validation for every route. A failure answers 400 with the API's one error shape,
// `{ error, requestId }` (app.ts `onError`), instead of @hono/zod-validator's default body (the raw
// Zod error), which clients cannot show. Import `zValidator` from here, not from the library.
import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";

export function zValidator<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
  /** Shown instead of the issues, when they would not help the person who sees it. */
  message?: string,
) {
  return honoZValidator(target, schema, (result) => {
    if (result.success) return;
    if (message) throw new HTTPException(400, { message });
    // Paths and expectations only: Zod's issue messages never quote the input.
    const issues = result.error.issues.map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    );
    throw new HTTPException(400, { message: `invalid ${target}: ${issues.join("; ")}` });
  });
}
