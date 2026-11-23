import { z } from "zod";

/** An optional variable where empty means unset, as `.env` files and dashboards leave it. */
export const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/** A comma-separated variable as a list, trimmed, without empty entries; unset is `[]`. */
export const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
