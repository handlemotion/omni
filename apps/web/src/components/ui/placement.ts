type Side = "top" | "bottom" | "left" | "right" | "start" | "end";
type Align = "start" | "center" | "end";

/** React Aria's placement strings ("bottom end", "end top"), which callers still pass. */
export type Placement =
  | Side
  | `${Side} ${Align}`
  | `${"left" | "right" | "start" | "end"} ${"top" | "bottom"}`;

/** Splits a placement into UI SDK's `side` and `align`. */
export function toSideAlign(placement: Placement): { side: Side; align: Align } {
  const [side, align = "center"] = placement.split(" ") as [Side, string?];
  return { side, align: align === "top" ? "start" : align === "bottom" ? "end" : (align as Align) };
}
