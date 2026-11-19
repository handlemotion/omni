/**
 * Layout probes that run inside the page (`page.evaluate`), so each is self-contained. They find elements by what they show,
 * never by test IDs or class names, so a restyle that keeps the text keeps the checks.
 */

export interface Offender {
  element: string;
  left: number;
  right: number;
}

/**
 * Every visible element whose box leaves the viewport sideways, innermost first (an ancestor
 * that overflows only because of an offending child is left out), and the document's widths.
 * Elements inside a sideways scroller (a horizontal list) are allowed past the edge.
 */
export function sidewaysOverflow(slack: number) {
  const viewport = document.documentElement.clientWidth;
  const describe = (element: Element) => {
    const role = element.getAttribute("role");
    const text = (element.textContent ?? "").replaceAll(/\s+/g, " ").trim();
    return `<${element.tagName.toLowerCase()}${role ? ` role=${role}` : ""}> "${text.length > 70 ? `${text.slice(0, 70)}…` : text}"`;
  };
  const scrollsSideways = (element: Element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const sideways = style.overflowX === "auto" || style.overflowX === "scroll";
      const vertical = style.overflowY === "auto" || style.overflowY === "scroll";
      if (sideways && !vertical) return true;
    }
    return false;
  };
  const outside: Element[] = [];
  for (const element of document.body.querySelectorAll("*")) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (getComputedStyle(element).visibility === "hidden") continue;
    if (box.right <= viewport + slack && box.left >= -slack) continue;
    if (!scrollsSideways(element)) outside.push(element);
  }
  const innermost = outside.filter(
    (element) => !outside.some((other) => other !== element && element.contains(other)),
  );
  return {
    viewport,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: innermost.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        element: describe(element),
        left: Math.round(box.left),
        right: Math.round(box.right),
      } satisfies Offender;
    }),
  };
}

/** How one text element sits in its lines: how many, whether its text spills or hides below, how it ends. */
export function lineFit(element: Element) {
  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
  return {
    lines: Math.round(element.getBoundingClientRect().height / lineHeight),
    spills: element.scrollWidth > element.clientWidth + 1,
    clips: style.overflowX === "hidden" || style.overflow === "hidden",
    hiddenBelow: element.scrollHeight > element.clientHeight + 1,
    ellipsis:
      style.textOverflow === "ellipsis" ||
      (style.getPropertyValue("-webkit-line-clamp") || "none") !== "none",
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  };
}

/** Whether `inner`'s box lies within `outer`'s, sideways. */
export function sidewaysInside(inner: Element, outer: Element) {
  const slack = 0.5;
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return {
    inside: a.left >= b.left - slack && a.right <= b.right + slack,
    inner: { left: Math.round(a.left), right: Math.round(a.right) },
    outer: { left: Math.round(b.left), right: Math.round(b.right) },
  };
}

/** Whether a wrapping block shows all of its text: no lines hidden below its box. */
export function showsInFull(element: Element) {
  return {
    text: element.textContent ?? "",
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  };
}
