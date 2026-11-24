import { GridLayout, Size, type GridLayoutOptions } from "react-aria-components/Virtualizer";
import type { LayoutInfo } from "react-aria-components/Virtualizer";

const CARD = 176;
/** A narrower card for a folder shown in a pane (a CRM record's Files tab): about six a row. */
export const COMPACT_CARD = 104;
const GAP_X = 12;
const GAP_Y = 16;
const INSET_START = 14;
const INSET_END = 4;
const GUESS_EXTRA = 48;

export const cardsLayout = (card = CARD) =>
  ({
    minItemSize: new Size(card, card + GUESS_EXTRA),
    minSpace: new Size(GAP_X, GAP_Y),
    loaderHeight: 0,
  }) satisfies GridLayoutOptions;

export const CARDS_LAYOUT = cardsLayout();
export const COMPACT_CARDS_LAYOUT = cardsLayout(COMPACT_CARD);

/**
 * Every card is as tall as it is wide plus the same caption (`file-card.tsx`), so only the
 * first card is measured and the rest follow it: each measurement resizes the list and lays it
 * out again, and measuring every card was most of a folder's first render. Cards are `CARD` wide
 * whatever the width (a panel opening beside them takes columns away, not size), and the room
 * left over widens the gaps, so the outer cards' art lines up with the page header's padding on
 * both sides (`ps-5`, `pe-2.5` in `storage-frame.tsx`, less the card's own `p-1.5`).
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
    const card = context.layoutOptions?.minItemSize?.width ?? CARD;
    const full = this.virtualizer?.size.width ?? 0;
    const inner = full - INSET_START - INSET_END;
    const columns = Math.max(1, Math.floor((inner + GAP_X) / (card + GAP_X)));
    const width = Math.min(card, Math.max(0, inner));
    const gap = columns > 1 ? (inner - width * columns) / (columns - 1) : GAP_X;
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
      info.rect.x = INSET_START + column * (width + gap);
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
