import { GridLayout, Size, type GridLayoutOptions } from "react-aria-components/Virtualizer";
import type { LayoutInfo } from "react-aria-components/Virtualizer";

const CARD = 140;
const GAP_X = 12;
const GAP_Y = 16;
const INSET_START = 14;
const INSET_END = 4;
const GUESS_EXTRA = 48;

export const CARDS_LAYOUT: GridLayoutOptions = {
  minItemSize: new Size(CARD, CARD + GUESS_EXTRA),
  minSpace: new Size(GAP_X, GAP_Y),
  loaderHeight: 0,
};

/**
 * Every card is as tall as it is wide plus the same caption (`file-card.tsx`), so only the
 * first card is measured and the rest follow it: each measurement resizes the list and lays it
 * out again, and measuring every card was most of a folder's first render. Cards are at least
 * `CARD` wide and stretch to fill the row, so their art lines up with the page header's padding
 * on both sides (`ps-5`, `pe-2.5` in `storage-frame.tsx`, less the card's own `p-1.5`).
 */
export class CardsLayout<T> extends GridLayout<T> {
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
    const inner = full - INSET_START - INSET_END;
    const columns = Math.max(1, Math.floor((inner + GAP_X) / (CARD + GAP_X)));
    const width = Math.max(0, (inner - GAP_X * (columns - 1)) / columns);
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
      info.rect.x = INSET_START + column * (width + GAP_X);
      info.rect.y = Math.floor(index / columns) * (height + GAP_Y);
      info.rect.width = width;
      info.rect.height = height;
      info.estimatedSize = this.extra === null && index === 0;
      index += 1;
    }
    const rows = Math.ceil(index / columns);
    self.contentSize = new Size(full, Math.max(0, rows * (height + GAP_Y) - GAP_Y));
  }
}
