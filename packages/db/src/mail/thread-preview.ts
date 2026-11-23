import { sql, type SQL } from "drizzle-orm";

/** Drops links (bare, or in parentheses after their text) from a message's text. */
export function withoutLinks(text: SQL) {
  return sql`regexp_replace(${text}, '\\(\\s*https?://[^\\s)]*\\s*\\)|https?://\\S+', ' ', 'g')`;
}

/**
 * The first `chars` characters of message `m`'s text with links dropped and whitespace collapsed,
 * as inbox rows show it. Reads `sourceChars` of the text, enough to fill `chars` after links go.
 */
export function cleanPreview(chars: number, sourceChars: number) {
  return sql`left(btrim(regexp_replace(${withoutLinks(sql`left(m.clean_text, ${sql.raw(String(sourceChars))})`)}, '\\s+', ' ', 'g')), ${sql.raw(String(chars))})`;
}

/** The newest message's subject, preview and sender, as a thread row's `latest` column holds it. */
export interface LatestMessage {
  subject: string;
  fromName: string | null;
  fromAddress: string;
  snippet: string;
}

/** A thread row's `latest` column spread into the fields inbox rows show. */
export function withLatest<Row extends { latest: LatestMessage | null }>({ latest, ...row }: Row) {
  return {
    ...row,
    subject: latest?.subject ?? "",
    snippet: latest?.snippet ?? "",
    latestFrom: latest ? { name: latest.fromName, address: latest.fromAddress } : null,
  };
}
