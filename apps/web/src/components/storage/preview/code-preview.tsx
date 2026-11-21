import { memo, useEffect, useMemo, useState } from "react";
import type { GrammarState, HighlighterCore, LanguageInput, ThemedToken } from "shiki/core";
import { SkeletonBox } from "skullet/react";
import { useFileText } from "@/hooks/use-storage-preview.ts";
import type { FileKind } from "@/lib/file-kind.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { NoPreview, StageLoading } from "./shared.tsx";

const HIGHLIGHT_LINES = 4000;
const BLOCK = 200;
const LINE_PX = 20;
const THEME = "github-light";
const FIRST_BLOCKS = 2;
const BLOCKS_PER_STEP = 4;

export default function CodePreview(props: {
  source: PreviewSource;
  kind: FileKind;
  language?: string | undefined;
  onDownload?: (() => void) | undefined;
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
  const drawn = useDrawnBlocks(blocks.length);
  const gutter = `calc(${String(lines.length).length}ch + 36px)`;
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <pre
        className="w-max min-w-full py-4 font-mono text-sm/5 text-foreground"
        style={{ tabSize: 2 }}
      >
        {blocks.map((start, block) => (
          <Block
            key={start}
            start={start}
            lines={lines}
            gutter={gutter}
            drawn={block < drawn}
            tokens={tokens[block]}
          />
        ))}
      </pre>
    </div>
  );
});

const Block = memo(function Block(props: {
  start: number;
  lines: string[];
  gutter: string;
  drawn: boolean;
  tokens: ThemedToken[][] | undefined;
}) {
  const { start, lines } = props;
  const count = Math.min(BLOCK, lines.length - start);
  return (
    <div
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${count * LINE_PX}px`,
        ...(props.drawn ? {} : { height: count * LINE_PX }),
      }}
    >
      {props.drawn &&
        lines
          .slice(start, start + count)
          .map((line, i) => (
            <Line
              key={start + i}
              number={start + i + 1}
              gutter={props.gutter}
              text={line}
              tokens={props.tokens?.[i]}
            />
          ))}
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

const breathe = () =>
  new Promise<void>((resume) =>
    typeof requestIdleCallback === "undefined"
      ? setTimeout(resume, 0)
      : requestIdleCallback(() => resume(), { timeout: 100 }),
  );

function useDrawnBlocks(total: number) {
  const [drawn, setDrawn] = useState(FIRST_BLOCKS);
  useEffect(() => {
    if (drawn >= total) return;
    let live = true;
    void breathe().then(() => live && setDrawn(drawn + BLOCKS_PER_STEP));
    return () => {
      live = false;
    };
  }, [drawn, total]);
  return drawn;
}

function useTokens(lines: string[], language: string | undefined) {
  const [tokens, setTokens] = useState<ThemedToken[][][]>([]);
  useEffect(() => {
    setTokens([]);
    const grammar = language && GRAMMARS[language];
    if (!language || !grammar) return;
    let live = true;
    void (async () => {
      const shiki = await getHighlighter();
      if (!live) return;
      if (!shiki.getLoadedLanguages().includes(language)) {
        await shiki.loadLanguage((await grammar()).default);
      }
      const done: ThemedToken[][][] = [];
      let grammarState: GrammarState | undefined;
      for (let start = 0; start < Math.min(lines.length, HIGHLIGHT_LINES); start += BLOCK) {
        if (!live) return;
        const block = shiki.codeToTokensBase(lines.slice(start, start + BLOCK).join("\n"), {
          lang: language,
          theme: THEME,
          ...(grammarState ? { grammarState } : {}),
        });
        grammarState = shiki.getLastGrammarState(block);
        done.push(block);
        setTokens([...done]);
        await breathe();
      }
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [lines, language]);
  return tokens;
}
