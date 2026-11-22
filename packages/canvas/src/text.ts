import type { Box, CanvasElement, Scene } from "./scene.ts";
import { frameOf } from "./tree.ts";
import { union } from "./board.ts";

const topLeft = (element: CanvasElement) => element.box ?? [Infinity, Infinity, 0, 0];

const reading = (a: CanvasElement, b: CanvasElement) => {
  const [ax, ay] = topLeft(a);
  const [bx, by] = topLeft(b);
  return ay - by || ax - bx;
};

const connectorFrame = (byId: Map<string, CanvasElement>, element: CanvasElement) => {
  const [from, to] = [element.from?.id, element.to?.id].map((id) =>
    id === undefined ? undefined : byId.get(id),
  );
  const frame = from && frameOf(byId, from);
  return frame && to && frameOf(byId, to) === frame ? frame : undefined;
};

function sections(scene: Scene) {
  const byId = new Map(scene.elements.map((element) => [element.id, element]));
  const frames = scene.elements.filter((element) => element.kind === "frame").toSorted(reading);
  const inFrame = new Map<string, CanvasElement[]>(frames.map((frame) => [frame.id, []]));
  const outside: CanvasElement[] = [];
  for (const element of scene.elements) {
    if (element.kind === "frame") continue;
    const frame =
      element.kind === "connector" ? connectorFrame(byId, element) : frameOf(byId, element);
    (frame ? inFrame.get(frame.id)! : outside).push(element);
  }
  return {
    byId,
    frames: frames.map((frame) => ({ frame, held: inFrame.get(frame.id)!.toSorted(reading) })),
    outside: outside.toSorted(reading),
  };
}

/**
 * The canvas's words for search, in reading order: each frame's title and then its elements, top
 * to bottom and left to right, then the elements outside frames. No ids, kinds or coordinates.
 */
export function canvasText(scene: Scene) {
  const { frames, outside } = sections(scene);
  const lines: string[] = [];
  const say = (element: CanvasElement) => {
    const words = element.text?.trim();
    if (words) lines.push(words);
  };
  for (const { frame, held } of frames) {
    say(frame);
    held.forEach(say);
  }
  outside.forEach(say);
  return lines.join("\n");
}

/** What a tile's file is to the reader: its name and url, or null when they cannot open it. */
export type TileLookup = (fileId: string) => { name: string; url: string } | null;

const n = (value: number) => String(Math.round(value));
const boxText = ([x, y, w, h]: Box) => `[${n(x)},${n(y)} ${n(w)}×${n(h)}]`;
const quoted = (text: string | undefined) => (text?.trim() ? ` ${JSON.stringify(text)}` : "");

function line(element: CanvasElement, byId: Map<string, CanvasElement>, tiles: TileLookup) {
  const head = `${element.kind} ${element.id}`;
  if (element.kind === "connector") {
    const end = (at: CanvasElement["from"]) =>
      at?.id !== undefined && byId.has(at.id) ? at.id : `(${n(at!.at[0])},${n(at!.at[1])})`;
    return `${head} ${end(element.from)} → ${end(element.to)} ${element.route ?? "straight"}${quoted(element.text)}`;
  }
  if (element.kind === "group") {
    const held = [...byId.values()].filter((item) => item.parent === element.id);
    return `${head} (${held.map((item) => item.id).join(", ")})`;
  }
  const parts = [head];
  if (element.shape) parts.push(element.shape);
  if (element.color) parts.push(element.color);
  if (element.box) parts.push(boxText(element.box));
  if (element.locked) parts.push("locked");
  if (element.kind === "file") {
    const file = tiles(element.file!);
    const where = [
      element.page ? `page ${element.page}` : "",
      element.sheet ? `sheet ${JSON.stringify(element.sheet)}` : "",
      element.range ?? "",
    ].filter(Boolean);
    parts.push(file ? `→ ${JSON.stringify(file.name)} ${file.url}` : "→ no access", ...where);
  }
  return parts.join(" ") + quoted(element.text);
}

/**
 * The canvas as an agent reads it: a heading line, then each frame and what it holds, then the
 * elements outside frames, one line each with id, kind, style, box and text. A tile names its
 * file only when `tiles` says the reader can open it. With `only`, just those elements' lines.
 */
export function canvasOutline(name: string, scene: Scene, tiles: TileLookup, only?: Set<string>) {
  const { byId, frames, outside } = sections(scene);
  const shown = (element: CanvasElement) => !only || only.has(element.id);
  const lines: string[] = [];
  if (!only) {
    const all = union(scene.elements.flatMap((element) => (element.box ? [element.box] : [])));
    const extent = all
      ? ` · board ${n(all[0])},${n(all[1])} to ${n(all[0] + all[2])},${n(all[1] + all[3])}`
      : " · empty";
    lines.push(
      `Canvas ${JSON.stringify(name)} · ${scene.elements.length} ${scene.elements.length === 1 ? "element" : "elements"} · ${frames.length} ${frames.length === 1 ? "frame" : "frames"}${extent}`,
    );
  }
  for (const { frame, held } of frames) {
    const items = held.filter(shown);
    if (shown(frame)) lines.push(`# frame ${frame.id}${quoted(frame.text)} ${boxText(frame.box!)}`);
    else if (items.length) lines.push(`# in frame ${frame.id}${quoted(frame.text)}`);
    for (const element of items) lines.push(`- ${line(element, byId, tiles)}`);
  }
  const loose = outside.filter(shown);
  if (loose.length && (frames.length || !only)) lines.push("# outside frames");
  for (const element of loose) lines.push(`- ${line(element, byId, tiles)}`);
  return lines.join("\n");
}

/** The Drive files a canvas shows as tiles. */
export const tileFiles = (scene: Scene) => [
  ...new Set(scene.elements.flatMap((element) => (element.file ? [element.file] : []))),
];
