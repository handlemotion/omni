import { z } from "zod";

/**
 * The most elements a canvas holds, and the largest body. The live layer starts a document with
 * one record holding its whole state (a seed or snap), and a record must stay under 1 MiB: a
 * 400 KB body's state is about 740 KB, with room for its history.
 */
export const CANVAS_MAX_ELEMENTS = 2_000;
export const CANVAS_MAX_BYTES = 400_000;
/** The longest text one element holds. */
export const CANVAS_MAX_TEXT = 5_000;
/** The most Drive files one canvas shows as tiles. */
export const CANVAS_MAX_FILES = 100;
/** How far from the origin a board reaches, and the largest side of an element. */
export const CANVAS_MAX_COORD = 1_000_000;
export const CANVAS_MAX_SIZE = 100_000;
/** How deep groups nest. Frames sit at the top level only. */
export const CANVAS_MAX_GROUP_DEPTH = 4;

export const ELEMENT_KINDS = [
  "shape",
  "sticky",
  "text",
  "connector",
  "frame",
  "group",
  "image",
  "file",
] as const;
export const SHAPES = ["rectangle", "rounded", "ellipse", "diamond", "triangle"] as const;
/** Colour names the app maps to tokens in light and dark mode; never hex. */
export const COLORS = [
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "blue",
  "teal",
  "green",
  "gray",
  "white",
] as const;
export const TEXT_SIZES = ["s", "m", "l", "xl"] as const;
export const ROUTES = ["straight", "elbow", "curve"] as const;
export const HEADS = ["none", "arrow", "dot"] as const;

const coord = z.number().finite().min(-CANVAS_MAX_COORD).max(CANVAS_MAX_COORD);
const side = z.number().finite().min(1).max(CANVAS_MAX_SIZE);
const point = z.tuple([coord, coord]);

/** An element's id: made by whoever creates it, and kept for its whole life. */
export const elementIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const endSchema = z.object({
  id: elementIdSchema.optional().describe("The element this end is bound to; none for a free end."),
  at: point.describe("Where the end was last drawn: used when the bound element is gone."),
});

export const elementSchema = z
  .object({
    id: elementIdSchema,
    kind: z.enum(ELEMENT_KINDS),
    /** The frame or group the element sits in. */
    parent: elementIdSchema.optional(),
    /** `[x, y, w, h]` in board units. */
    box: z.tuple([coord, coord, side, side]).optional(),
    rot: z.number().finite().min(-360).max(360).optional(),
    shape: z.enum(SHAPES).optional(),
    color: z.enum(COLORS).optional(),
    size: z.enum(TEXT_SIZES).optional(),
    route: z.enum(ROUTES).optional(),
    start: z.enum(HEADS).optional(),
    end: z.enum(HEADS).optional(),
    from: endSchema.optional(),
    to: endSchema.optional(),
    /** A Drive file shown as a tile: its id, never its name. */
    file: z.string().min(1).max(64).optional(),
    page: z.number().int().min(1).max(100_000).optional(),
    sheet: z.string().min(1).max(200).optional(),
    range: z
      .string()
      .regex(/^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$/)
      .optional(),
    /** An image that belongs to the canvas: its Drive file. */
    node: z.string().min(1).max(64).optional(),
    locked: z.boolean().optional(),
    text: z.string().optional(),
  })
  .superRefine((element, context) => {
    const missing = (field: string) =>
      context.addIssue({ code: "custom", message: `a ${element.kind} needs \`${field}\`` });
    const boxed = element.kind !== "connector" && element.kind !== "group";
    if (boxed && !element.box) missing("box");
    if (element.kind === "connector" && (!element.from || !element.to)) missing("from` and `to");
    if (element.kind === "file" && !element.file) missing("file");
    if (element.kind === "image" && !element.node) missing("node");
  });

export type CanvasElement = z.infer<typeof elementSchema>;
export type ElementKind = CanvasElement["kind"];
export type Box = NonNullable<CanvasElement["box"]>;
export type ConnectorEnd = NonNullable<CanvasElement["from"]>;

/** A canvas: its elements in paint order, parents before their children. */
export interface Scene {
  elements: CanvasElement[];
}

export const sceneFileSchema = z.object({
  omni: z.literal("canvas"),
  v: z.literal(1),
  elements: z.array(elementSchema),
});

/** The fields of an element, in the order the JSON body writes them. */
export const FIELDS = [
  "id",
  "kind",
  "parent",
  "box",
  "rot",
  "shape",
  "color",
  "size",
  "route",
  "start",
  "end",
  "from",
  "to",
  "file",
  "page",
  "sheet",
  "range",
  "node",
  "locked",
  "text",
] as const satisfies readonly (keyof CanvasElement)[];

/** Whether elements of `kind` hold text. */
export const holdsText = (kind: ElementKind) => kind !== "group" && kind !== "image";

declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** A new element id: 10 random base32 characters. */
export function newElementId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte & 31];
  return id;
}

/** A copy of JSON data: elements and their fields are nothing else. */
export const copy = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
