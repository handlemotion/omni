import { CARD_ROWS, grid } from "@omni/client";
import Papa from "papaparse";

/**
 * A CSV's top-left corner as rows of cells, for a card's grid. Parsed as records first, so a
 * quoted field that spans lines stays one cell.
 */
export function csvGrid(text: string, name: string) {
  const delimiter = /\.tsv$/i.test(name) ? "\t" : "";
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    preview: CARD_ROWS,
    skipEmptyLines: true,
  });
  return grid(parsed.data);
}
