// The Storage tables as the code before sync (ADR 0043) reads and writes them: without the sync
// columns migration 0043 adds. The Worker and the migration deploy in no fixed order, and Drizzle
// names every column of a table in each insert and in each `select()` or `returning()`, so until
// the sync code lands Storage goes through these and never names a column that may not exist yet.
// The sync layer removes this file and goes back to `schema/storage.ts`.
import { pgTable } from "drizzle-orm/pg-core";
import { storageNodeStoredColumns, storageUploadStoredColumns } from "../schema/storage.ts";

export const storageNodes = pgTable("storage_nodes", storageNodeStoredColumns);
export const storageUploads = pgTable("storage_uploads", storageUploadStoredColumns);
