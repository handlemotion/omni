import { sql, type SQL } from "drizzle-orm";
import { boolean, foreignKey, index, integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { orgId, timestamptz, tsvector } from "../columns.ts";
import { storageNodes } from "../storage.ts";

/**
 * What reading a file's text came to: its text (`ok`), none in it (`empty`), a kind we do not
 * read (`unsupported`), over the size we read (`too_large`), or a read that failed (`failed`,
 * tried again a few times).
 */
export const storageTextStatus = pgEnum("storage_text_status", [
  "ok",
  "empty",
  "unsupported",
  "too_large",
  "failed",
]);

/**
 * The plain text of a file's current content, for search and for agents to read. One row per
 * file, rewritten when its `content_version` moves on; the indexer finds files whose row is
 * missing or behind, so new uploads and files from before it existed are read the same way.
 */
export const storageTexts = pgTable(
  "storage_texts",
  {
    nodeId: text("node_id").primaryKey(),
    orgId: orgId(),
    /** The file's `content_version` this text was read from. */
    contentVersion: integer("content_version").notNull(),
    status: storageTextStatus("status").notNull(),
    text: text("text").notNull().default(""),
    /** The text stops at the cap; the file holds more. */
    truncated: boolean("truncated").notNull().default(false),
    /**
     * Read with pictures and scanned PDFs transcribed by the model. A picture or a PDF read
     * without it, before OCR was set up, is read once more when it is.
     */
    ocr: boolean("ocr").notNull().default(false),
    /** Failed reads of this `content_version`; the indexer stops trying after a few. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * Words in any language, unstemmed: Drive holds Spanish and English side by side, and an
     * English stemmer would mangle the Spanish. Over the text's first 150k characters, which
     * keeps the vector under Postgres's 1 MB.
     */
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(() => sql`to_tsvector('simple', left(text, 150000))` satisfies SQL),
    readAt: timestamptz("read_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "storage_texts_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    index("storage_texts_org_id_idx").on(t.orgId),
    index("storage_texts_search_vector_idx").using("gin", t.searchVector),
  ],
);
