import {
  CANVAS_MAX_BYTES,
  CANVAS_MAX_ELEMENTS,
  CANVAS_MAX_TEXT,
  CANVAS_MAX_FILES,
  FIELDS,
  sceneFileSchema,
  type CanvasElement,
  type Scene,
} from "./scene.ts";

const round = (value: number) => Math.round(value * 100) / 100;

const rounded: (value: unknown) => unknown = (value) => {
  if (typeof value === "number") return round(value);
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, rounded(inner)]));
  }
  return value;
};

function elementLine(element: CanvasElement) {
  const fields: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = element[field];
    if (value !== undefined) fields[field] = rounded(value);
  }
  return JSON.stringify(fields);
}

/**
 * The canvas's body: the scene as JSON, one element per line in paint order, so a version diff
 * is a list of whole elements. Written the same way every time.
 */
export function sceneToJson(scene: Scene) {
  const lines = scene.elements.map((element) => `    ${elementLine(element)}`);
  const elements = lines.length ? `[\n${lines.join(",\n")}\n  ]` : "[]";
  return `{\n  "omni": "canvas",\n  "v": 1,\n  "elements": ${elements}\n}\n`;
}

export type SceneResult = { ok: true; scene: Scene } | { ok: false; error: string };

/** What is wrong with a scene beyond its schema (an id used twice, a connector joined to a connector), or null. */
export function sceneProblem(scene: Scene) {
  const kinds = new Map<string, CanvasElement["kind"]>();
  for (const element of scene.elements) {
    if (kinds.has(element.id)) return `Two elements share the id "${element.id}".`;
    kinds.set(element.id, element.kind);
  }
  const joined = scene.elements.find((element) =>
    [element.from?.id, element.to?.id].some((id) => id && kinds.get(id) === "connector"),
  );
  if (joined)
    return `The connector "${joined.id}" is joined to a connector: join elements instead.`;
  return null;
}

function utf8Length(text: string) {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

/**
 * Why changing `before` into `after` is refused for the canvas's size (more than
 * `CANVAS_MAX_BYTES` of JSON, `CANVAS_MAX_ELEMENTS` elements, `CANVAS_MAX_FILES` tiles, or
 * `CANVAS_MAX_TEXT` characters in one element), or null. Only growth past a limit
 * is refused: a board people took past one by editing at once stays readable and editable, and
 * can shrink.
 */
export function limitProblem(before: Scene, after: Scene) {
  const bytes = (scene: Scene) => utf8Length(sceneToJson(scene));
  const size = bytes(after);
  if (size > CANVAS_MAX_BYTES && size > bytes(before)) {
    return `A canvas holds at most ${CANVAS_MAX_BYTES / 1000} KB; this would make ${Math.ceil(size / 1000)} KB.`;
  }
  const tiles = (scene: Scene) =>
    scene.elements.filter((element) => element.kind === "file").length;
  const count = after.elements.length;
  if (count > CANVAS_MAX_ELEMENTS && count > before.elements.length) {
    return `A canvas holds at most ${CANVAS_MAX_ELEMENTS} elements; this would make ${count}.`;
  }
  if (tiles(after) > CANVAS_MAX_FILES && tiles(after) > tiles(before)) {
    return `A canvas shows at most ${CANVAS_MAX_FILES} Drive files.`;
  }
  const was = new Map(before.elements.map((element) => [element.id, element.text?.length ?? 0]));
  const long = after.elements.find(
    (element) =>
      (element.text?.length ?? 0) > CANVAS_MAX_TEXT &&
      (element.text?.length ?? 0) > (was.get(element.id) ?? 0),
  );
  if (long) return `An element's text holds at most ${CANVAS_MAX_TEXT} characters ("${long.id}").`;
  return null;
}

const unread = (error: string) => {
  const result: SceneResult = { ok: false, error };
  return result;
};

/** Reads a canvas's body; an empty body is an empty canvas. */
export function sceneFromJson(text: string) {
  const empty: SceneResult = { ok: true, scene: { elements: [] } };
  if (!text.trim()) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unread("The canvas is not JSON.");
  }
  const parsed = sceneFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return unread(`The canvas does not read as a scene${where}: ${issue?.message}`);
  }
  const scene: Scene = { elements: parsed.data.elements };
  const problem = sceneProblem(scene);
  const read: SceneResult = problem ? { ok: false, error: problem } : { ok: true, scene };
  return read;
}
