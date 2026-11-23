import { Platform, StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text.tsx";
import {
  audioBars,
  codeTones,
  csvGrid,
  docPage,
  textLines,
  type CodeTone,
} from "@/lib/card-page.ts";
import { useCardText } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { fileKindOf, usesHashComments } from "@/lib/file-kind.ts";
import { colors, radius, space, type ColorToken } from "@/theme/tokens.ts";
import { FileGlyph } from "./file-glyph.tsx";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

const TONE: Record<CodeTone, ColorToken> = {
  keyword: "chart3",
  string: "warning",
  comment: "mutedForeground",
  plain: "surface",
};

const NUMERIC = /^-?[\d.,%$€£]+$/;

/**
 * A file's first lines drawn as a mini page inside its square card, matching the web's `FilePage`
 * 1:1: doc title & body, syntax-tinted code on dark, plain text, or a CSV cell grid. Sizes scale
 * proportionally to `width` (mirroring the web's `cqw` units).
 */
export function FilePage({ node, width }: { node: DriveNode; width: number }) {
  const kind = fileKindOf(node);
  const query = useCardText(node, node.size > 0);
  if (query.isError || query.data?.binary) {
    return <FileGlyph kind={kind} size={space(8)} />;
  }
  if (node.size === 0) {
    return kind === "doc" ? (
      <DocBody text="" name={node.name} width={width} />
    ) : (
      <View style={styles.page} />
    );
  }
  if (!query.data) return <FileGlyph kind={kind} size={space(8)} />;
  if (kind === "doc") return <DocBody text={query.data.text} name={node.name} width={width} />;
  if (kind === "csv") return <CsvGrid rows={csvGrid(query.data.text, node.name)} width={width} />;
  if (kind === "code") {
    return <CodeBody text={query.data.text} hash={usesHashComments(node.name)} width={width} />;
  }
  return <PlainBody text={query.data.text} width={width} />;
}

/** Deterministic 28-bar waveform for audio files, matching the web's `AudioArt`. */
export function AudioArt({ name }: { name: string }) {
  const heights = audioBars(name);
  return (
    <View style={styles.waveform}>
      {heights.map((height, i) => (
        <View key={i} style={[styles.bar, { height: `${height}%` }]} />
      ))}
    </View>
  );
}

function DocBody({ text, name, width }: { text: string; name: string; width: number }) {
  const page = docPage(text, name);
  const pad = width * 0.1;
  const titleSize = Math.max(5.5, width * 0.065);
  const bodySize = Math.max(4, width * 0.046);
  return (
    <View style={[styles.page, { padding: pad }]}>
      <Text
        weight="medium"
        numberOfLines={1}
        style={{ fontSize: titleSize, lineHeight: titleSize * 1.3 }}
      >
        {page.title}
      </Text>
      <View style={{ marginTop: width * 0.03 }}>
        {page.body.map((line, i) => (
          <Text
            key={i}
            weight={line.kind === "heading" ? "medium" : "regular"}
            tone={line.kind === "heading" ? "foreground" : "mutedForeground"}
            numberOfLines={1}
            style={{
              fontSize: bodySize,
              lineHeight: bodySize * 1.65,
              marginTop: line.kind === "heading" ? width * 0.02 : 0,
            }}
          >
            {line.kind === "bullet" ? `• ${line.text}` : line.text || " "}
          </Text>
        ))}
      </View>
    </View>
  );
}

function PlainBody({ text, width }: { text: string; width: number }) {
  const pad = width * 0.1;
  const bodySize = Math.max(4, width * 0.046);
  return (
    <View style={[styles.page, { padding: pad }]}>
      {textLines(text).map((line, i) => (
        <Text
          key={i}
          tone="mutedForeground"
          numberOfLines={1}
          style={{ fontSize: bodySize, lineHeight: bodySize * 1.65 }}
        >
          {line || " "}
        </Text>
      ))}
    </View>
  );
}

function CodeBody({ text, hash, width }: { text: string; hash: boolean; width: number }) {
  const pad = width * 0.1;
  const codeSize = Math.max(5, width * 0.06);
  return (
    <View style={[styles.page, styles.dark, { padding: pad }]}>
      {textLines(text).map((line, i) => (
        <Text
          key={i}
          tone="surface"
          numberOfLines={1}
          style={{ fontFamily: MONO, fontSize: codeSize, lineHeight: codeSize * 1.6 }}
        >
          {line
            ? codeTones(line, hash).map((part, j) => (
                <Text
                  key={j}
                  tone={TONE[part.tone]}
                  style={{ fontFamily: MONO, fontSize: codeSize, lineHeight: codeSize * 1.6 }}
                >
                  {part.text}
                </Text>
              ))
            : " "}
        </Text>
      ))}
    </View>
  );
}

function CsvGrid({ rows, width }: { rows: string[][]; width: number }) {
  const cellSize = Math.max(4.5, width * 0.054);
  const padV = width * 0.022;
  const padH = width * 0.034;
  return (
    <View style={styles.page}>
      <View style={{ width: width * 2 }}>
        {rows.map((row, r) => (
          <View key={r} style={[styles.gridRow, r === 0 && styles.gridHeader]}>
            {row.map((cell, c) => (
              <View
                key={c}
                style={[styles.gridCell, { paddingVertical: padV, paddingHorizontal: padH }]}
              >
                <Text
                  tone={r === 0 ? "foreground" : "mutedForeground"}
                  tabular
                  numberOfLines={1}
                  style={{
                    fontSize: cellSize,
                    lineHeight: cellSize * 1.5,
                    textAlign: c < 2 && NUMERIC.test(cell) ? "right" : "left",
                  }}
                >
                  {cell || " "}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  dark: { backgroundColor: colors.tooltip },
  gridRow: { flexDirection: "row" },
  gridHeader: { backgroundColor: colors.accent },
  gridCell: {
    flex: 1,
    minWidth: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  waveform: {
    width: "75%",
    height: "40%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bar: {
    width: "2.5%",
    borderRadius: radius.full,
    backgroundColor: colors.waveform,
  },
});
