import { useRef, type CSSProperties, type ReactNode } from "react";
import { useCardSheets, useCardText } from "@/hooks/use-storage-preview.ts";
import { codeTones, csvGrid, docPage, grid, textLines, type CodeTone } from "@/lib/card-page.ts";
import { SHEET_PREVIEW_MAX_BYTES, type FileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "../file-card.tsx";
import { FileGlyph } from "../file-glyph.tsx";

const PAGE = "absolute inset-0 @container overflow-hidden";
const MINI: Record<"title" | "body" | "cell" | "code", CSSProperties> = {
  title: { fontSize: "6.5cqw", lineHeight: 1.3 },
  body: { fontSize: "4.6cqw", lineHeight: 1.65 },
  cell: { fontSize: "5.4cqw", lineHeight: 1.5 },
  code: { fontSize: "6cqw", lineHeight: 1.6 },
};
const MARGIN: CSSProperties = { padding: "10cqw" };

const TONE: Record<CodeTone, string> = {
  keyword: "text-chart-3",
  string: "text-warning",
  comment: "text-muted-foreground",
  plain: "text-background",
};

const HASH_COMMENTS = new Set([
  "python",
  "ruby",
  "shellscript",
  "yaml",
  "toml",
  "docker",
  "elixir",
]);
const OMNI_TYPE = /^text\/vnd\.omni\.(?!doc\b)/i;

/**
 * Whether a card draws this file as a page: docs, code, text, CSV, and workbooks under 2 MB (read
 * whole). Omni's other types (a sheet's JSON, a canvas's) are text inside but not to read as text.
 */
export function hasPage(node: StorageNode, type: FileType) {
  if (OMNI_TYPE.test(node.mimeType ?? "")) return false;
  if (type.preview === "sheet") return node.size > 0 && node.size <= CARD_SHEET_MAX_BYTES;
  return type.preview === "text" || type.preview === "csv";
}

const CARD_SHEET_MAX_BYTES = Math.min(2 * 1024 * 1024, SHEET_PREVIEW_MAX_BYTES);

/**
 * The file's first lines drawn as a page: a doc's title and text, code, a grid of cells. The page
 * is the whole card, one margin all round (a PDF, with pages behind it, stays a stack). Its text is sized in
 * `cqw` (hundredths of the page's width), so it reads the same at every card width.
 */
export function FilePage(props: { node: StorageNode; type: FileType; url: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const near = useSeen(anchor);
  const { node, type } = props;
  return (
    <>
      <span ref={anchor} aria-hidden className="absolute inset-0" />
      {type.preview === "sheet" ? (
        <SheetPage node={node} type={type} url={props.url} near={near} />
      ) : (
        <TextPage node={node} type={type} url={props.url} near={near} />
      )}
    </>
  );
}

function TextPage(props: { node: StorageNode; type: FileType; url: string; near: boolean }) {
  const { node, type } = props;
  const source = { url: props.url, version: node.updatedAt, size: node.size };
  const text = useCardText(source, props.near);
  if (text.isError || text.data?.binary) return <Glyph type={type} />;
  if (node.size === 0) {
    return type.kind === "doc" ? <DocBody text="" name={node.name} /> : <Page>{null}</Page>;
  }
  if (!text.data) return <Glyph type={type} />;
  if (type.kind === "doc") return <DocBody text={text.data.text} name={node.name} />;
  if (type.preview === "csv") {
    return <Grid rows={csvGrid(text.data.text, node.name)} />;
  }
  if (type.kind === "code") {
    return <CodeBody text={text.data.text} hash={HASH_COMMENTS.has(type.language ?? "")} />;
  }
  return <PlainBody text={text.data.text} />;
}

function SheetPage(props: { node: StorageNode; type: FileType; url: string; near: boolean }) {
  const { node } = props;
  const source = { url: props.url, version: node.updatedAt, size: node.size };
  const sheets = useCardSheets(source, props.near);
  const first = sheets.data?.[0];
  if (!first) return <Glyph type={props.type} />;
  return <Grid rows={grid(first.rows)} />;
}

function Page(props: { children: ReactNode; bare?: boolean; dark?: boolean }) {
  return (
    <div aria-hidden className={`${PAGE} ${props.dark ? "bg-tooltip" : "bg-background"}`}>
      <div style={props.bare ? undefined : MARGIN}>{props.children}</div>
    </div>
  );
}

function Glyph(props: { type: FileType }) {
  return <FileGlyph kind={props.type.kind} className="size-8 text-muted-foreground" />;
}

function DocBody(props: { text: string; name: string }) {
  const page = docPage(props.text, props.name);
  return (
    <Page>
      <p style={MINI.title} className="truncate font-medium text-foreground">
        {page.title}
      </p>
      <div style={{ ...MINI.body, marginTop: "3cqw" }}>
        {page.body.map((line, i) => (
          <p
            key={i}
            className={`truncate ${line.kind === "heading" ? "mt-[2cqw] font-medium text-foreground" : "text-muted-foreground"}`}
          >
            {line.kind === "bullet" ? `• ${line.text}` : line.text || "\u00a0"}
          </p>
        ))}
      </div>
    </Page>
  );
}

function PlainBody(props: { text: string }) {
  return (
    <Page>
      <div style={MINI.body} className="text-muted-foreground">
        {textLines(props.text).map((line, i) => (
          <p key={i} className="truncate whitespace-pre">
            {line || "\u00a0"}
          </p>
        ))}
      </div>
    </Page>
  );
}

function CodeBody(props: { text: string; hash: boolean }) {
  return (
    <Page dark>
      <pre style={MINI.code} className="font-mono">
        {textLines(props.text).map((line, i) => (
          <span key={i} className="block whitespace-pre">
            {line
              ? codeTones(line, props.hash).map((part, j) => (
                  <span key={j} className={TONE[part.tone]}>
                    {part.text}
                  </span>
                ))
              : "\u00a0"}
          </span>
        ))}
      </pre>
    </Page>
  );
}

function Grid(props: { rows: string[][] }) {
  return (
    <Page bare>
      <table style={{ ...MINI.cell, width: "200cqw" }} className="table-fixed border-collapse">
        <tbody>
          {props.rows.map((row, r) => (
            <tr key={r} className={r === 0 ? "bg-accent text-foreground" : "text-muted-foreground"}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{ padding: "2.2cqw 3.4cqw" }}
                  className={`truncate border-e border-b border-border tabular-nums ${c < 2 && /^-?[\d.,%$€£]+$/.test(cell) ? "text-end" : ""}`}
                >
                  {cell || "\u00a0"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
