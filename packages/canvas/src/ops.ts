import { z } from "zod";
import { anchor, Board, GAP, OpError, overlap } from "./board.ts";
import { limitProblem, sceneProblem } from "./json.ts";
import {
  COLORS,
  CANVAS_MAX_GROUP_DEPTH,
  HEADS,
  newElementId,
  ROUTES,
  sceneFileSchema,
  SHAPES,
  TEXT_SIZES,
  type Box,
  type CanvasElement,
  type Scene,
} from "./scene.ts";
import { groupDepth, paintOrder } from "./tree.ts";

const target = z
  .string()
  .min(1)
  .max(64)
  .describe("An element's id, or a `ref` made earlier in the call.");
const targets = z.array(target).min(1).max(500);
const ref = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .describe("A name you make up for the new element, to use in later operations of this call.");
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const placement = z
  .object({
    near: target,
    side: z.enum(["right", "left", "above", "below"]),
    gap: z.number().finite().min(0).max(2_000).optional(),
  })
  .describe("Next to another element, `gap` apart (40 by default).");
const style = {
  color: z.enum(COLORS).optional(),
  shape: z.enum(SHAPES).optional().describe("A shape's outline (shapes only)."),
  size: z.enum(TEXT_SIZES).optional().describe("Text size."),
};
const tile = {
  page: z.number().int().min(1).optional().describe("A PDF tile's page."),
  sheet: z.string().min(1).max(200).optional().describe("A sheet tile's sheet."),
  range: z.string().min(1).max(40).optional().describe("A sheet tile's range, like A1:F20."),
};
const text = z.string().max(5_000);
const side = z.number().finite().min(1).max(100_000);

export const canvasOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    kind: z.enum(["sticky", "shape", "text", "frame", "file"]),
    ref: ref.optional(),
    text: text.optional().describe("What it says; a frame's title."),
    parent: target.optional().describe("A frame or group to put it in."),
    at: point.optional().describe("Its top left corner."),
    place: placement.optional(),
    w: side.optional(),
    h: side.optional(),
    file_id: z.string().min(1).max(64).optional().describe("For a file tile: the Drive file."),
    ...style,
    ...tile,
  }),
  z.object({
    op: z.literal("update"),
    id: target,
    text: text.optional(),
    locked: z.boolean().optional(),
    ...style,
    ...tile,
  }),
  z.object({
    op: z.literal("move"),
    ids: targets,
    to: point.optional().describe("Where the top left of what moves goes."),
    by: z.object({ dx: z.number().finite(), dy: z.number().finite() }).optional(),
    place: placement.optional(),
    into: target.optional().describe('A frame to move them into, or "board" to take them out.'),
  }),
  z.object({ op: z.literal("resize"), id: target, w: side, h: side }),
  z.object({
    op: z.literal("connect"),
    from: target,
    to: target,
    ref: ref.optional(),
    text: text.optional().describe("A label on the line."),
    route: z.enum(ROUTES).optional(),
    start: z.enum(HEADS).optional(),
    end: z.enum(HEADS).optional().describe("The head at `to`: an arrow by default."),
  }),
  z.object({
    op: z.literal("arrange"),
    ids: targets,
    as: z.enum(["row", "column", "grid"]),
    gap: z.number().finite().min(0).max(2_000).optional(),
    columns: z.number().int().min(1).max(100).optional(),
    align: z.enum(["start", "center", "end"]).optional(),
  }),
  z.object({ op: z.literal("group"), ids: targets, ref: ref.optional() }),
  z.object({ op: z.literal("ungroup"), id: target }),
  z.object({ op: z.literal("frame"), title: text, ids: targets.optional(), ref: ref.optional() }),
  z.object({
    op: z.literal("order"),
    ids: targets,
    to: z.union([z.enum(["front", "back"]), z.object({ above: target })]),
  }),
  z.object({ op: z.literal("delete"), ids: targets }),
]);

export type CanvasOp = z.infer<typeof canvasOpSchema>;
type Op<K extends CanvasOp["op"]> = Extract<CanvasOp, { op: K }>;

const SIZES: Record<Op<"add">["kind"], [number, number]> = {
  sticky: [200, 200],
  shape: [200, 120],
  text: [300, 60],
  frame: [800, 600],
  file: [400, 500],
};

function makeRef(board: Board, wanted: string | undefined, id: string) {
  if (wanted === undefined) return;
  if (board.refs.has(wanted) || board.byId.has(wanted)) {
    throw new OpError(`The ref "${wanted}" is already taken in this call or on the canvas.`);
  }
  board.refs.set(wanted, id);
}

function containerFor(board: Board, parent: string | undefined, kind: string) {
  if (parent === undefined) return undefined;
  const found = board.get(parent);
  if (found.kind !== "frame" && found.kind !== "group") {
    throw new OpError(`"${parent}" is a ${found.kind}: only frames and groups hold elements.`);
  }
  if (kind === "frame") throw new OpError("Frames sit on the board, not inside other elements.");
  return found;
}

function insideFrame(board: Board, frame: CanvasElement, w: number, h: number) {
  const [fx, fy, fw, fh] = frame.box!;
  const held = board.boundsOfAll([...board.under(frame.id)].map((id) => board.byId.get(id)!));
  const x = fx + GAP;
  const y = held ? held[1] + held[3] + GAP : fy + GAP * 2;
  frame.box = [fx, fy, Math.max(fw, w + GAP * 2), Math.max(fh, y + h + GAP - fy)];
  board.touch(frame);
  return { x, y };
}

function add(board: Board, op: Op<"add">) {
  if (op.kind === "file" && !op.file_id) throw new OpError("A file tile needs `file_id`.");
  if (op.at && op.place) throw new OpError("Give `at` or `place`, not both.");
  const parent = containerFor(board, op.parent, op.kind);
  const [dw, dh] = SIZES[op.kind];
  const w = op.w ?? dw;
  const h = op.h ?? dh;
  const corner = op.at
    ? op.at
    : op.place
      ? board.placed(op.place, w, h)
      : parent?.kind === "frame"
        ? insideFrame(board, parent, w, h)
        : board.edge();
  const element: CanvasElement = {
    id: newElementId(),
    kind: op.kind,
    box: [corner.x, corner.y, w, h],
    ...(parent ? { parent: parent.id } : {}),
    ...(op.kind === "shape" ? { shape: op.shape ?? "rectangle" } : {}),
    ...(op.color ? { color: op.color } : op.kind === "sticky" ? { color: "yellow" } : {}),
    ...(op.size ? { size: op.size } : {}),
    ...(op.kind === "file"
      ? { file: op.file_id, page: op.page, sheet: op.sheet, range: op.range }
      : {}),
    ...(op.text !== undefined && op.kind !== "file" ? { text: op.text } : {}),
  };
  makeRef(board, op.ref, element.id);
  board.add(element);
}

function update(board: Board, op: Op<"update">) {
  const element = board.get(op.id);
  const fail = (field: string) => {
    throw new OpError(`A ${element.kind} has no \`${field}\`.`);
  };
  if (op.text !== undefined) {
    if (element.kind === "group" || element.kind === "image" || element.kind === "file")
      fail("text");
    element.text = op.text;
  }
  if (op.shape !== undefined) {
    if (element.kind !== "shape") fail("shape");
    element.shape = op.shape;
  }
  for (const field of ["page", "sheet", "range"] as const) {
    if (op[field] === undefined) continue;
    if (element.kind !== "file") fail(field);
    Object.assign(element, { [field]: op[field] });
  }
  if (op.color !== undefined) element.color = op.color;
  if (op.size !== undefined) element.size = op.size;
  if (op.locked !== undefined) element.locked = op.locked;
  board.touch(element);
}

function moveInto(board: Board, moving: CanvasElement[], into: string) {
  const frame = into === "board" ? undefined : board.get(into);
  if (frame && frame.kind !== "frame") throw new OpError(`"${into}" is not a frame.`);
  touchAncestors(board, new Set(moving.map((element) => element.id)));
  for (const element of moving) {
    if (element.kind === "frame") throw new OpError("A frame cannot go inside another frame.");
    if (frame) element.parent = frame.id;
    else delete element.parent;
    board.touch(element);
  }
}

function refuseTied(board: Board, elements: CanvasElement[]) {
  const moving = new Set(elements.flatMap((element) => [element.id, ...board.under(element.id)]));
  for (const element of elements) {
    if (element.kind === "connector" && (element.from?.id ?? element.to?.id) !== undefined) {
      throw new OpError(`"${element.id}" moves with the elements it joins: move those instead.`);
    }
    for (const id of board.under(element.id)) {
      const inside = board.byId.get(id);
      const outside = [inside?.from?.id, inside?.to?.id].find((end) => end && !moving.has(end));
      if (outside) {
        throw new OpError(`"${id}" in "${element.id}" joins "${outside}": move "${outside}" too.`);
      }
    }
  }
}

function move(board: Board, op: Op<"move">) {
  const moving = op.ids.map((id) => board.get(id));
  const given = [op.to, op.by, op.place].filter((way) => way !== undefined).length;
  if (given > 1) throw new OpError("Give one of `to`, `by` or `place`.");
  if (!given && op.into === undefined)
    throw new OpError("Say where: `to`, `by`, `place` or `into`.");
  if (given) refuseTied(board, moving);
  const bounds = board.boundsOfAll(moving);
  if (given && !bounds) throw new OpError("Nothing in `ids` has a place on the board to move.");
  if (given && bounds) {
    const self = new Set(moving.map((element) => element.id));
    const corner = op.place ? board.placed(op.place, bounds[2], bounds[3], self) : op.to;
    const dx = op.by ? op.by.dx : corner!.x - bounds[0];
    const dy = op.by ? op.by.dy : corner!.y - bounds[1];
    board.shift(moving, dx, dy);
  }
  if (op.into !== undefined) moveInto(board, moving, op.into);
}

function resize(board: Board, op: Op<"resize">) {
  const element = board.get(op.id);
  if (!element.box) throw new OpError(`A ${element.kind} has no size of its own.`);
  if (element.locked) throw new OpError(`"${op.id}" is locked: unlock it with \`update\` first.`);
  element.box = [element.box[0], element.box[1], op.w, op.h];
  board.touch(element);
}

const centre = (box: Box) => [box[0] + box[2] / 2, box[1] + box[3] / 2] satisfies [number, number];

function connect(board: Board, op: Op<"connect">) {
  const from = board.get(op.from);
  const to = board.get(op.to);
  const ends = [from, to].map((element) => board.boundsOf(element));
  if (!ends[0] || !ends[1] || from.kind === "connector" || to.kind === "connector") {
    throw new OpError("A connector joins two elements that have a place on the board.");
  }
  const element: CanvasElement = {
    id: newElementId(),
    kind: "connector",
    from: { id: from.id, at: anchor(ends[0], centre(ends[1])) },
    to: { id: to.id, at: anchor(ends[1], centre(ends[0])) },
    route: op.route ?? "straight",
    end: op.end ?? "arrow",
    ...(op.start ? { start: op.start } : {}),
    ...(op.text !== undefined ? { text: op.text } : {}),
  };
  makeRef(board, op.ref, element.id);
  board.add(element);
}

function arrange(board: Board, op: Op<"arrange">) {
  const items = op.ids.map((id) => board.get(id));
  for (const item of items) refuseTied(board, [item]);
  const inside = items.find((item) => items.some((other) => board.under(other.id).has(item.id)));
  if (inside) throw new OpError(`"${inside.id}" is inside another element being arranged.`);
  const boxes = items.map((element) => board.boundsOf(element));
  if (boxes.some((box) => !box)) throw new OpError("Only elements with a place can be arranged.");
  const [x0, y0] = board.boundsOfAll(items)!;
  const gap = op.gap ?? GAP;
  const cw = Math.max(...boxes.map((box) => box![2]));
  const ch = Math.max(...boxes.map((box) => box![3]));
  const columns =
    op.as === "row"
      ? items.length
      : op.as === "column"
        ? 1
        : (op.columns ?? Math.ceil(Math.sqrt(items.length)));
  const offset = (room: number, size: number) =>
    op.align === "center" ? (room - size) / 2 : op.align === "end" ? room - size : 0;
  let cursor = op.as === "row" ? x0 : y0;
  items.forEach((element, i) => {
    const [bx, by, bw, bh] = boxes[i]!;
    const target =
      op.as === "row"
        ? { x: cursor, y: y0 + offset(ch, bh) }
        : op.as === "column"
          ? { x: x0 + offset(cw, bw), y: cursor }
          : { x: x0 + (i % columns) * (cw + gap), y: y0 + Math.floor(i / columns) * (ch + gap) };
    cursor += (op.as === "row" ? bw : bh) + gap;
    board.shift([element], target.x - bx, target.y - by);
  });
}

function siblingsOf(board: Board, ids: string[]) {
  const items = ids.map((id) => board.get(id));
  const parent = items[0]!.parent;
  if (items.some((element) => element.parent !== parent)) {
    throw new OpError("These elements are not in the same frame or group.");
  }
  return { items, parent };
}

function group(board: Board, op: Op<"group">) {
  if (op.ids.length < 2) throw new OpError("A group holds at least two elements.");
  const { items, parent } = siblingsOf(board, op.ids);
  if (items.some((element) => element.kind === "frame"))
    throw new OpError("Frames are not grouped.");
  const element: CanvasElement = {
    id: newElementId(),
    kind: "group",
    ...(parent ? { parent } : {}),
  };
  board.add(element, Math.min(...items.map((item) => board.elements.indexOf(item))));
  for (const item of items) {
    item.parent = element.id;
    board.touch(item);
  }
  for (const id of board.under(element.id)) {
    if (groupDepth(board.byId, board.byId.get(id)!) > CANVAS_MAX_GROUP_DEPTH) {
      throw new OpError(`Groups nest at most ${CANVAS_MAX_GROUP_DEPTH} deep.`);
    }
  }
  makeRef(board, op.ref, element.id);
}

function ungroup(board: Board, op: Op<"ungroup">) {
  const element = board.get(op.id);
  if (element.kind !== "group") throw new OpError(`"${op.id}" is not a group.`);
  const gone = new Set([element.id]);
  for (const item of board.elements) if (!gone.has(item.id)) board.unbind(item, gone);
  for (const child of board.elements.filter((item) => item.parent === element.id)) {
    if (element.parent === undefined) delete child.parent;
    else child.parent = element.parent;
    board.touch(child);
  }
  board.remove(gone);
}

function frame(board: Board, op: Op<"frame">) {
  const items = (op.ids ?? []).map((id) => board.get(id));
  if (items.some((element) => element.parent !== undefined || element.kind === "frame")) {
    throw new OpError("A frame takes elements that are on the board, outside other frames.");
  }
  const held = board.boundsOfAll(items);
  const box: Box = held
    ? [held[0] - GAP, held[1] - GAP * 2, held[2] + GAP * 2, held[3] + GAP * 3]
    : [board.edge().x, board.edge().y, ...SIZES.frame];
  const element: CanvasElement = { id: newElementId(), kind: "frame", box, text: op.title };
  const first = items.length
    ? Math.min(...items.map((item) => board.elements.indexOf(item)))
    : undefined;
  board.add(element, first);
  for (const item of items) {
    item.parent = element.id;
    board.touch(item);
  }
  makeRef(board, op.ref, element.id);
}

function order(board: Board, op: Op<"order">) {
  const { items } = siblingsOf(board, op.ids);
  const anchorAt = typeof op.to === "object" ? board.get(op.to.above) : null;
  if (anchorAt && anchorAt.parent !== items[0]!.parent) {
    throw new OpError("`above` names an element in another frame or group.");
  }
  const moving = new Set(items);
  const rest = board.elements.filter((element) => !moving.has(element));
  const at = op.to === "front" ? rest.length : op.to === "back" ? 0 : rest.indexOf(anchorAt!) + 1;
  board.elements = [...rest.slice(0, at), ...items, ...rest.slice(at)];
  for (const item of items) board.touch(item);
}

function touchAncestors(board: Board, gone: Set<string>) {
  for (const id of gone) {
    let at = board.byId.get(id)?.parent;
    for (let hops = 0; at !== undefined && hops < 64; hops++) {
      const ancestor = board.byId.get(at);
      if (ancestor && !gone.has(ancestor.id)) board.touch(ancestor);
      at = ancestor?.parent;
    }
  }
}

function remove(board: Board, op: Op<"delete">) {
  const gone = new Set<string>();
  for (const id of op.ids) {
    const element = board.get(id);
    if (element.locked) throw new OpError(`"${id}" is locked: unlock it with \`update\` first.`);
    gone.add(element.id);
    for (const below of board.under(element.id)) {
      if (board.byId.get(below)?.locked) {
        throw new OpError(`"${below}" inside "${id}" is locked: unlock it with \`update\` first.`);
      }
      gone.add(below);
    }
  }
  for (const element of board.elements) {
    if (!gone.has(element.id)) board.unbind(element, gone);
  }
  touchAncestors(board, gone);
  board.remove(gone);
}

function apply(board: Board, op: CanvasOp) {
  switch (op.op) {
    case "add":
      return add(board, op);
    case "update":
      return update(board, op);
    case "move":
      return move(board, op);
    case "resize":
      return resize(board, op);
    case "connect":
      return connect(board, op);
    case "arrange":
      return arrange(board, op);
    case "group":
      return group(board, op);
    case "ungroup":
      return ungroup(board, op);
    case "frame":
      return frame(board, op);
    case "order":
      return order(board, op);
    case "delete":
      return remove(board, op);
  }
}

const MAX_OVERLAPS = 20;

function newOverlaps(board: Board, before: Map<string, Box>) {
  const solid = board.elements.filter(
    (element) => element.box && element.kind !== "frame" && element.kind !== "connector",
  );
  const pairs: [string, string][] = [];
  for (const id of board.changed) {
    const a = board.byId.get(id);
    if (!a?.box || a.kind === "frame" || a.kind === "connector") continue;
    for (const b of solid) {
      if (b.id === a.id || (board.changed.has(b.id) && b.id < a.id)) continue;
      const was =
        before.get(a.id) && before.get(b.id) && overlap(before.get(a.id)!, before.get(b.id)!);
      if (!was && overlap(a.box, b.box!)) pairs.push([a.id, b.id]);
      if (pairs.length >= MAX_OVERLAPS) return pairs;
    }
  }
  return pairs;
}

export type OpsResult =
  | {
      ok: true;
      scene: Scene;
      /** The id each `ref` became. */
      created: Record<string, string>;
      /** Ids of the elements changed or made, in paint order. */
      changed: string[];
      overlaps: [string, string][];
    }
  | { ok: false; error: string };

const failed = (error: string) => {
  const result: OpsResult = { ok: false, error };
  return result;
};

/**
 * Applies `ops` in order to `scene`, all or none: a new scene (to write with `rewriteCanvas`)
 * or what is wrong, naming the operation.
 */
export function applyCanvasOps(scene: Scene, ops: CanvasOp[]) {
  const board = new Board(scene.elements);
  const before = new Map(scene.elements.flatMap((e) => (e.box ? [[e.id, e.box] as const] : [])));
  for (const [index, op] of ops.entries()) {
    try {
      apply(board, op);
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      return failed(`Operation ${index + 1} (${op.op}): ${error.message}`);
    }
  }
  board.redrawEnds();
  const elements = paintOrder(
    board.elements.map((element, i) => ({ element, z: String(i).padStart(6, "0") })),
  );
  const checked = sceneFileSchema.safeParse({ omni: "canvas", v: 1, elements });
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return failed(`The canvas would not be valid: ${issue?.message} at ${issue?.path.join(".")}.`);
  }
  const problem = sceneProblem({ elements }) ?? limitProblem(scene, { elements });
  if (problem) return failed(problem);
  const done: OpsResult = {
    ok: true,
    scene: { elements },
    created: Object.fromEntries(board.refs),
    changed: elements.filter((element) => board.changed.has(element.id)).map((e) => e.id),
    overlaps: newOverlaps(board, before),
  };
  return done;
}
