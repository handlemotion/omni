import { copy, type Box, type CanvasElement, type ConnectorEnd } from "./scene.ts";
import { descendants } from "./tree.ts";

/** A mistake in an operation, said to whoever sent it. */
export class OpError extends Error {}

/** Where to put something next to another element. */
export interface Placement {
  near: string;
  side: "right" | "left" | "above" | "below";
  gap?: number;
}

/** Room left between things the board places itself. */
export const GAP = 40;

/** A scene being changed by operations: its elements in paint order, by id. */
export class Board {
  elements: CanvasElement[];
  readonly byId = new Map<string, CanvasElement>();
  /** Ids whose fields changed, and the ones made here. */
  readonly changed = new Set<string>();
  readonly refs = new Map<string, string>();

  constructor(elements: CanvasElement[]) {
    this.elements = copy(elements);
    for (const element of this.elements) this.byId.set(element.id, element);
  }

  /** The element an id or a ref made earlier in the call names. */
  get(target: string) {
    const id = this.refs.get(target) ?? target;
    const element = this.byId.get(id);
    if (!element) throw new OpError(`No element "${target}" on the canvas.`);
    return element;
  }

  add(element: CanvasElement, index = this.elements.length) {
    this.elements.splice(index, 0, element);
    this.byId.set(element.id, element);
    this.changed.add(element.id);
  }

  remove(ids: Set<string>) {
    this.elements = this.elements.filter((element) => !ids.has(element.id));
    for (const id of ids) {
      this.byId.delete(id);
      this.changed.delete(id);
    }
  }

  touch(element: CanvasElement) {
    this.changed.add(element.id);
  }

  under(id: string) {
    return descendants(this.elements, id);
  }

  /** An element's bounds: its box, or for a group what its children cover. */
  boundsOf(element: CanvasElement) {
    if (element.box) return element.box;
    if (element.kind === "connector" && element.from && element.to) {
      const points = [this.pointOf(element.from), this.pointOf(element.to)];
      return union(points.map(([x, y]) => [x, y, 0, 0] satisfies Box));
    }
    if (element.kind !== "group") return null;
    const boxes: Box[] = [];
    for (const id of this.under(element.id)) {
      const inside = this.byId.get(id);
      if (inside?.box) boxes.push(inside.box);
      for (const end of [inside?.from, inside?.to]) {
        if (end) boxes.push([end.at[0], end.at[1], 0, 0]);
      }
    }
    return union(boxes);
  }

  /** What the elements cover together. */
  boundsOfAll(elements: CanvasElement[]) {
    return union(elements.map((element) => this.boundsOf(element)).filter((box) => !!box));
  }

  /** Where everything on the board ends: to the right of it is free. */
  edge() {
    const all = this.boundsOfAll(this.elements.filter((element) => element.box));
    return all ? { x: all[0] + all[2] + GAP * 2, y: all[1] } : { x: 0, y: 0 };
  }

  /** The top left corner for something `w` by `h` placed as `placement` says. */
  placed(placement: Placement, w: number, h: number, self?: Set<string>) {
    const near = this.get(placement.near);
    if (self?.has(near.id)) throw new OpError(`"${placement.near}" is one of the things moved.`);
    const box = this.boundsOf(near);
    if (!box) throw new OpError(`"${placement.near}" has no place on the board to be next to.`);
    const gap = placement.gap ?? GAP;
    const [x, y, nw, nh] = box;
    if (placement.side === "right") return { x: x + nw + gap, y };
    if (placement.side === "left") return { x: x - gap - w, y };
    if (placement.side === "below") return { x, y: y + nh + gap };
    return { x, y: y - gap - h };
  }

  /** Moves elements, and everything inside them, by `dx`, `dy`. */
  shift(elements: CanvasElement[], dx: number, dy: number) {
    const moving = new Set<string>();
    for (const element of elements) {
      moving.add(element.id);
      for (const id of this.under(element.id)) moving.add(id);
    }
    for (const id of moving) {
      const element = this.byId.get(id)!;
      if (element.locked) throw new OpError(`"${id}" is locked: unlock it with \`update\` first.`);
      if (element.box) {
        const [x, y, w, h] = element.box;
        element.box = [x + dx, y + dy, w, h];
      }
      for (const end of [element.from, element.to]) {
        if (end && end.id === undefined) end.at = [end.at[0] + dx, end.at[1] + dy];
      }
      this.touch(element);
    }
  }

  /**
   * Points every connector end bound to an element that moved where it is drawn now, again until
   * nothing moves: a group's bounds cover the connectors inside it, so they settle first.
   */
  redrawEnds() {
    for (let pass = 0; pass < 8 && this.redrawPass(); pass++);
  }

  private redrawPass() {
    let moved = false;
    for (const element of this.elements) {
      if (element.kind !== "connector" || !element.from || !element.to) continue;
      const ends: [ConnectorEnd, ConnectorEnd][] = [
        [element.from, element.to],
        [element.to, element.from],
      ];
      if (![element.from.id, element.to.id].some((id) => id && this.reshaped(id))) continue;
      for (const [end, other] of ends) {
        if (end.id === undefined) continue;
        const bound = this.byId.get(end.id);
        const box = bound ? this.boundsOf(bound) : null;
        if (!box) continue;
        const at = anchor(box, this.pointOf(other));
        if (at[0] === end.at[0] && at[1] === end.at[1]) continue;
        end.at = at;
        this.touch(element);
        moved = true;
      }
    }
    return moved;
  }

  /** Frees a connector's ends bound to `gone`, drawing both ends first if either element changed. */
  unbind(element: CanvasElement, gone: Set<string>) {
    if (!element.from || !element.to) return;
    const ends = [
      [element.from, element.to],
      [element.to, element.from],
    ] as const;
    if (!ends.some(([end]) => end.id !== undefined && gone.has(end.id))) return;
    if (ends.some(([end]) => end.id !== undefined && this.reshaped(end.id))) {
      const at = ends.map(([end, other]) => {
        const bound = end.id === undefined ? undefined : this.byId.get(end.id);
        const box = bound ? this.boundsOf(bound) : null;
        return box ? anchor(box, this.pointOf(other)) : end.at;
      });
      ends.forEach(([end], i) => (end.at = at[i]!));
    }
    for (const [end] of ends) if (end.id !== undefined && gone.has(end.id)) delete end.id;
    this.touch(element);
  }

  /** Whether an element's bounds may have changed: it, or anything inside it, changed. */
  reshaped(id: string) {
    return this.changed.has(id) || [...this.under(id)].some((below) => this.changed.has(below));
  }

  /** Where a connector end is: the middle of its element, or its own point. */
  pointOf(end: ConnectorEnd) {
    const bound = end.id === undefined ? undefined : this.byId.get(end.id);
    const box = bound ? this.boundsOf(bound) : null;
    const middle: [number, number] = box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : end.at;
    return middle;
  }
}

/** The box that covers all of `boxes`; null for none. */
export function union(boxes: Box[]) {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box[0]));
  const top = Math.min(...boxes.map((box) => box[1]));
  const right = Math.max(...boxes.map((box) => box[0] + box[2]));
  const bottom = Math.max(...boxes.map((box) => box[1] + box[3]));
  const box: Box = [left, top, right - left, bottom - top];
  return box;
}

/** The middle of the side of `box` that faces `toward`. */
export function anchor(box: Box, toward: [number, number]) {
  const [x, y, w, h] = box;
  const dx = (toward[0] - (x + w / 2)) / w;
  const dy = (toward[1] - (y + h / 2)) / h;
  const side: [number, number] =
    Math.abs(dx) >= Math.abs(dy)
      ? dx >= 0
        ? [x + w, y + h / 2]
        : [x, y + h / 2]
      : dy >= 0
        ? [x + w / 2, y + h]
        : [x + w / 2, y];
  return side;
}

/** Whether two boxes share any area. */
export const overlap = (a: Box, b: Box) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
