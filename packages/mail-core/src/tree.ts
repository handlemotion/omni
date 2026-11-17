import { type DefaultTreeAdapterTypes, parse, parseFragment, serialize } from "parse5";

export type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

/** Elements deeper than this are flattened to their text. Chrome's parser stops at 512. */
export const MAX_HTML_DEPTH = 256;

/** The `<body>` of `html` parsed as a full document. */
export const parseBody: (html: string) => Element = (html) => {
  const doc = parse(html);
  const htmlElement = doc.childNodes.find(isElement);
  const body = htmlElement?.childNodes.find(
    (node): node is Element => isElement(node) && node.tagName === "body",
  );
  if (!body) throw new Error("parse5 always creates a body");
  return body;
};

/** `html` parsed in body context, so `<style>` from `<head>` stays in the tree. */
export const parseBodyFragment: (html: string) => DefaultTreeAdapterTypes.DocumentFragment = (
  html,
) => parseFragment(html);

export function innerHtml(node: ParentNode) {
  return serialize(node);
}

export function isElement(node: ChildNode | DefaultTreeAdapterTypes.Node): node is Element {
  return "tagName" in node;
}

export function attribute(element: Element, name: string) {
  return element.attrs.find((attr) => attr.name === name)?.value ?? null;
}

export function hasClass(element: Element, name: string) {
  return (attribute(element, "class") ?? "").split(/[\t\n\f\r ]+/).includes(name);
}

/** Every element under `root`, in document order. */
export const elements: (root: ParentNode) => Generator<Element> = function* (root) {
  const stack: ChildNode[] = root.childNodes.toReversed();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue;
    yield node;
    for (const child of node.childNodes.toReversed()) stack.push(child);
  }
};

export function remove(node: ChildNode) {
  const siblings = node.parentNode?.childNodes;
  const index = siblings?.indexOf(node) ?? -1;
  if (siblings && index !== -1) siblings.splice(index, 1);
}

export function textContent(root: ParentNode) {
  const parts: string[] = [];
  const stack: ChildNode[] = root.childNodes.toReversed();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.nodeName === "#text") parts.push((node as DefaultTreeAdapterTypes.TextNode).value);
    else if (isElement(node)) for (const child of node.childNodes.toReversed()) stack.push(child);
  }
  return parts.join("");
}

/**
 * Replaces the children of every element at `maxDepth` with their text, so nothing below it
 * is rendered as markup. Returns whether anything was flattened.
 */
export function capDepth(root: ParentNode, maxDepth = MAX_HTML_DEPTH) {
  let flattened = false;
  const stack: [Element, number][] = root.childNodes
    .filter(isElement)
    .map((element) => [element, 1] as [Element, number]);
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [element, depth] = entry;
    if (depth >= maxDepth && element.childNodes.some(isElement)) {
      const text: DefaultTreeAdapterTypes.TextNode = {
        nodeName: "#text",
        value: textContent(element),
        parentNode: element,
        sourceCodeLocation: null,
      };
      element.childNodes = [text];
      flattened = true;
      continue;
    }
    for (const child of element.childNodes) if (isElement(child)) stack.push([child, depth + 1]);
  }
  return flattened;
}
