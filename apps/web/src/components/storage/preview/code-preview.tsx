// Text and code: the file's first 512 KB as lines with their numbers (ADR 0040). Shown as plain
// text at once, then coloured by Shiki once its grammar has loaded (one chunk per language, on
// first use). Everything renders as React text nodes: a file's markup never becomes ours.
// Lines go in blocks the browser skips laying out while off screen, so 10,000 lines scroll freely.
import { memo, useEffect, useMemo, useState } from "react";
import type { HighlighterCore, LanguageInput, ThemedToken } from "shiki/core";
import { SkeletonBox } from "skullet/react";
import { useFileText } from "@/hooks/use-storage-preview.ts";
import type { FileKind } from "@/lib/file-kind.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { NoPreview, StageLoading } from "./shared.tsx";

/** Lines past this stay plain: highlighting is linear in the text and runs on the main thread. */
const HIGHLIGHT_LINES = 4000;
/** Lines per block that the browser lays out only near the screen. */
const BLOCK = 200;
/** The lines' leading, for the off-screen blocks' estimated height. */
const LINE_PX = 20;
const THEME = "github-light";

export default function CodePreview(props: {
  source: PreviewSource;
  kind: FileKind;
  language?: string | undefined;
  onDownload: () => void;
}) {
  const text = useFileText(props.source);
  if (text.isError || text.data?.binary) {
    return <NoPreview kind={props.kind} onDownload={props.onDownload} />;
  }
  if (!text.data) {
    return (
      <StageLoading label="Loading file">
        <div className="flex w-full flex-col gap-2.5">
          {[60, 42, 75, 30, 55, 68, 24].map((width, i) => (
            <SkeletonBox key={i} width={`${width}%`} height={10} />
          ))}
        </div>
      </StageLoading>
    );
  }
  return <Code text={text.data.text} language={props.language} />;
}

const Code = memo(function Code(props: { text: string; language?: string | undefined }) {
  const lines = useMemo(() => props.text.replace(/\r\n?/g, "\n").split("\n"), [props.text]);
  const tokens = useTokens(lines, props.language);
  const blocks = useMemo(() => {
    const out: number[] = [];
    for (let start = 0; start < lines.length; start += BLOCK) out.push(start);
    return out;
  }, [lines]);
  // The gutter fits the largest line number, plus its 20px start and 16px end padding.
  const gutter = `calc(${String(lines.length).length}ch + 36px)`;
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <pre
        className="w-max min-w-full py-4 font-mono text-sm/5 text-foreground"
        style={{ tabSize: 2 }}
      >
        {blocks.map((start) => (
          <div
            key={start}
            // Off-screen blocks skip layout and paint, holding their estimated height.
            style={{
              contentVisibility: "auto",
              containIntrinsicSize: `auto ${Math.min(BLOCK, lines.length - start) * LINE_PX}px`,
            }}
          >
            {lines.slice(start, start + BLOCK).map((line, i) => (
              <Line
                key={start + i}
                number={start + i + 1}
                gutter={gutter}
                text={line}
                tokens={tokens?.[start + i]}
              />
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
});

function Line(props: {
  number: number;
  gutter: string;
  text: string;
  tokens: ThemedToken[] | undefined;
}) {
  return (
    <div className="flex">
      <span
        aria-hidden
        style={{ width: props.gutter }}
        className="sticky left-0 shrink-0 bg-background pe-4 ps-5 text-end text-subtle-foreground tabular-nums select-none"
      >
        {props.number}
      </span>
      <code className="pe-5">
        {props.tokens
          ? props.tokens.map((token, i) => (
              <span key={i} style={{ color: token.color }}>
                {token.content}
              </span>
            ))
          : props.text || " "}
      </code>
    </div>
  );
}

/** The grammars `lib/file-kind.ts` names, each its own chunk, loaded on first use. */
const GRAMMARS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
};

let highlighter: Promise<HighlighterCore> | undefined;

/** One highlighter for the app, with the JavaScript regex engine (no WASM to fetch). */
async function getHighlighter() {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"),
  ]).then(([core, engine, theme]) =>
    core.createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    }),
  );
  return highlighter;
}

/** The first lines' tokens once the grammar is in; undefined until then, or with no grammar. */
function useTokens(lines: string[], language: string | undefined) {
  const [tokens, setTokens] = useState<ThemedToken[][]>();
  useEffect(() => {
    setTokens(undefined);
    if (!language) return;
    let live = true;
    void (async () => {
      const grammar = GRAMMARS[language];
      if (!grammar) return;
      const shiki = await getHighlighter();
      if (!live) return;
      if (!shiki.getLoadedLanguages().includes(language)) {
        await shiki.loadLanguage((await grammar()).default);
      }
      if (!live) return;
      const head = lines.slice(0, HIGHLIGHT_LINES).join("\n");
      setTokens(shiki.codeToTokensBase(head, { lang: language, theme: THEME }));
    })().catch(() => {
      // A grammar that fails to load leaves the text plain.
    });
    return () => {
      live = false;
    };
  }, [lines, language]);
  return tokens;
}
