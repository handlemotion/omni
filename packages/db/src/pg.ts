import type { Db } from "./client.ts";

/** A transaction on the database. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A Drizzle database or a transaction on one. */
export type Ex = Db | Tx;

/** Postgres refused a row for a unique key. */
export const isUniqueViolation = (error: unknown) => hasPgCode(error, "23505");

/** Postgres refused a delete or insert for a foreign key. */
export const isForeignKeyViolation = (error: unknown) => hasPgCode(error, "23503");

function hasPgCode(error: unknown, code: string) {
  return (
    (error as { cause?: { code?: string } }).cause?.code === code ||
    (error as { code?: string }).code === code
  );
}
