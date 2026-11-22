import { byKey } from "./order.ts";
import { copy, type CanvasElement, type ConnectorEnd } from "./scene.ts";

/** An element as the live document holds it, with its z-order key among its siblings. */
export interface Keyed {
  element: CanvasElement;
  z: string;
}

const containers = new Set(["frame", "group"]);

function dropBadParents(byId: Map<string, Keyed>) {
  for (const { element } of byId.values()) {
    if (element.parent === undefined) continue;
    const parent = byId.get(element.parent)?.element;
    const allowed =
      element.kind !== "frame" &&
      parent !== undefined &&
      containers.has(parent.kind) &&
      parent.id !== element.id;
    if (!allowed) delete element.parent;
  }
}

function breakCycles(byId: Map<string, Keyed>) {
  for (const start of byId.values()) {
    const path: CanvasElement[] = [];
    const seen = new Set<string>();
    let at: CanvasElement | undefined = start.element;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      path.push(at);
      at = at.parent === undefined ? undefined : byId.get(at.parent)?.element;
    }
    if (!at) continue;
    const cycle = path.slice(path.indexOf(at));
    const lowest = cycle.reduce((a, b) => (b.id < a.id ? b : a));
    delete lowest.parent;
  }
}

function childrenOf(byId: Map<string, Keyed>) {
  const children = new Map<string, CanvasElement[]>();
  for (const { element } of byId.values()) {
    if (element.parent === undefined) continue;
    children.set(element.parent, [...(children.get(element.parent) ?? []), element]);
  }
  return children;
}

function dissolveThinGroups(byId: Map<string, Keyed>) {
  for (;;) {
    const children = childrenOf(byId);
    const thin = [...byId.values()].find(
      ({ element }) => element.kind === "group" && (children.get(element.id)?.length ?? 0) < 2,
    )?.element;
    if (!thin) return;
    for (const child of children.get(thin.id) ?? []) {
      if (thin.parent === undefined) delete child.parent;
      else child.parent = thin.parent;
    }
    byId.delete(thin.id);
  }
}

function unbindMissing(end: ConnectorEnd | undefined, byId: Map<string, Keyed>) {
  if (end?.id === undefined) return;
  const bound = byId.get(end.id)?.element;
  if (!bound || bound.kind === "connector") delete end.id;
}

/**
 * The elements as a valid scene, in paint order (each parent before its children, siblings by
 * key): an element whose parent is gone sits at the top, parent cycles are broken, groups of
 * fewer than two dissolve, and a connector end whose element is gone, or is a connector, stays where it was drawn.
 * Pure: `elements` are copied, not changed.
 */
export function paintOrder(elements: Keyed[]) {
  const byId = new Map<string, Keyed>();
  for (const { element, z } of elements) {
    byId.set(element.id, { element: copy(element), z });
  }
  dropBadParents(byId);
  breakCycles(byId);
  dissolveThinGroups(byId);
  const children = new Map<string | undefined, Keyed[]>();
  for (const keyed of byId.values()) {
    unbindMissing(keyed.element.from, byId);
    unbindMissing(keyed.element.to, byId);
    const parent = keyed.element.parent;
    children.set(parent, [...(children.get(parent) ?? []), keyed]);
  }
  const ordered: CanvasElement[] = [];
  const visit = (parent: string | undefined) => {
    const siblings = (children.get(parent) ?? []).map((keyed) => ({
      ...keyed,
      id: keyed.element.id,
    }));
    for (const { element } of siblings.toSorted(byKey)) {
      ordered.push(element);
      visit(element.id);
    }
  };
  visit(undefined);
  return ordered;
}

/** The ids under `id`, at any depth. */
export function descendants(elements: CanvasElement[], id: string) {
  const below = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const element of elements) {
      const under =
        element.parent !== undefined && (element.parent === id || below.has(element.parent));
      if (under && !below.has(element.id)) {
        below.add(element.id);
        grew = true;
      }
    }
  }
  return below;
}

/** How many groups `element` sits inside. */
export function groupDepth(byId: Map<string, CanvasElement>, element: CanvasElement) {
  let depth = 0;
  for (let at = element.parent; at !== undefined; at = byId.get(at)?.parent) {
    if (byId.get(at)?.kind === "group") depth++;
    if (depth > 64) break;
  }
  return depth;
}

/** The frame `element` sits in, at any depth; undefined outside frames. */
export function frameOf(byId: Map<string, CanvasElement>, element: CanvasElement) {
  let at = element.parent === undefined ? undefined : byId.get(element.parent);
  for (let hops = 0; at && hops < 64; hops++) {
    if (at.kind === "frame") return at;
    at = at.parent === undefined ? undefined : byId.get(at.parent);
  }
  return undefined;
}
