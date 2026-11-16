// The virtualized cards' layout: React Aria's grid, placed exactly as the CSS grid it replaces
// (`repeat(auto-fill, minmax(10.5rem, 1fr))`, 12px across and 16px down, 14px in from each side,
// nothing above the first row). React Aria's own `GridLayout` puts its gap outside the grid too
// and a row's gap above it, so the cards would sit a pixel or two off the rows'.
import { GridLayout, Size, type GridLayoutOptions } from "react-aria-components/Virtualizer";
import type { LayoutInfo } from "react-aria-components/Virtualizer";

const MIN = 168;
const GAP_X = 12;
const GAP_Y = 16;
const INSET = 14;
/** A first guess at what a card adds to its width (its caption), until one is measured. */
const GUESS_EXTRA = 48;

export const CARDS_LAYOUT: GridLayoutOptions = {
  minItemSize: new Size(MIN, MIN + GUESS_EXTRA),
  minSpace: new Size(GAP_X, GAP_Y),
  loaderHeight: 0,
};

/**
 * Every card is as tall as it is wide plus the same caption (`file-card.tsx`), so only the
 * first card is measured and the rest follow it: each measurement resizes the list and lays it
 * out again, and measuring every card was most of a folder's first render.
 */
export class CardsLayout<T> extends GridLayout<T> {
  /** What a card adds to its width, once the first card has been measured. */
  private extra: number | null = null;
  private width = 0;

  override updateItemSize(_key: Parameters<GridLayout<T>["updateItemSize"]>[0], size: Size) {
    if (this.extra !== null) return false;
    this.extra = Math.round(size.height - this.width);
    return true;
  }

  override update(context: Parameters<GridLayout<T>["update"]>[0]) {
    super.update(context);
    const full = this.virtualizer?.size.width ?? 0;
    const inner = full - INSET * 2;
    const columns = Math.max(1, Math.floor((inner + GAP_X) / (MIN + GAP_X)));
    const width = (inner - GAP_X * (columns - 1)) / columns;
    this.width = width;
    const height = width + (this.extra ?? GUESS_EXTRA);
    const self = this as unknown as {
      layoutInfos: Map<unknown, LayoutInfo>;
      contentSize: Size;
      numColumns: number;
    };
    this.numColumns = columns;
    let index = 0;
    for (const info of self.layoutInfos.values()) {
      if (info.type !== "item") continue;
      const column = index % columns;
      info.rect.x = INSET + column * (width + GAP_X);
      info.rect.y = Math.floor(index / columns) * (height + GAP_Y);
      info.rect.width = width;
      info.rect.height = height;
      // Only the first card is measured, once.
      info.estimatedSize = this.extra === null && index === 0;
      index += 1;
    }
    const rows = Math.ceil(index / columns);
    self.contentSize = new Size(full, Math.max(0, rows * (height + GAP_Y) - GAP_Y));
  }
}
