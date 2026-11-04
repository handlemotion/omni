// Hairline illustrations for settings' empty states: isometric line figures drawn with the
// hairline-create skill's kernel (`.claude/skills/hairline-create`, Cam(45, 0.5): the 2:1 view;
// rounded solids as a silhouette and one crease), taken at rest as static paths.
//
// The kernel's palette maps onto our tokens, so a figure follows the theme: plates are filled with
// `background` (the card they sit on) and painted back to front so near ones hide far ones; the
// silhouette is `muted-foreground`, inner lines `subtle-foreground` and `hairline-line`, and one
// mark per figure is `foreground`: where the eye starts. Strokes stay 1px at any size.
import { cn } from "cn";

/** A path's role in the kernel's palette: plate, silhouette, crease, the one bright mark. */
type Stroke = "plate" | "sil" | "nf" | "lo" | "hi" | "fo" | "sil-plate";

const STROKE: Record<Stroke, string> = {
  plate: "fill-background stroke-subtle-foreground",
  "sil-plate": "fill-background stroke-muted-foreground",
  sil: "fill-none stroke-muted-foreground",
  nf: "fill-none stroke-subtle-foreground",
  lo: "fill-none stroke-hairline-line",
  hi: "fill-none stroke-foreground",
  fo: "fill-background stroke-none",
};

interface Figure {
  viewBox: string;
  paths: [d: string, stroke: Stroke][];
}

const FIGURES = {
  /** An empty tray: what holds things, holding nothing. The generic empty state. */
  tray: {
    viewBox: "98 102 204 128",
    paths: [
      [
        "M100.7 145.1L101.2 143.4L102.5 141.8L104.6 140.4L171.8 106.8L174.5 105.7L177.8 105.1L181.2 104.8L184.6 105.1L187.8 105.7L190.6 106.8L295.4 159.2L297.5 160.6L298.8 162.2L299.3 163.9L299.3 186.9L298.8 188.6L297.5 190.3L295.4 191.6L228.2 225.2L225.5 226.3L222.3 226.9L218.8 227.2L215.4 226.9L212.2 226.3L209.4 225.2L104.6 172.8L102.5 171.4L101.2 169.8L100.7 168.1Z",
        "sil-plate",
      ],
      [
        "M224.7 200.4L223 201.1L221 201.5L218.8 201.7L216.7 201.5L214.6 201.1L212.9 200.4L108.1 148L106.8 147.2L105.9 146.2L105.7 145.1L105.9 144L106.8 143L108.1 142.1L175.3 108.5L177 107.9L179 107.5L181.2 107.3L183.4 107.5L185.4 107.9L187.1 108.5L291.9 160.9L293.2 161.8L294.1 162.8L294.3 163.9L294.1 165L293.2 166L291.9 166.8Z",
        "nf",
      ],
      [
        "M105.9 163.7L106.8 162.7L108.1 161.9L175.3 128.3L177 127.6L179 127.2L181.2 127.1L183.4 127.2L185.4 127.6L187.1 128.3L291.9 180.7L293.2 181.5L294.1 182.6",
        "hi",
      ],
      [
        "M105.7 145.1L105.9 146.2L106.8 147.2L108.1 148L212.9 200.4L214.6 201.1L216.7 201.5L218.8 201.7L221 201.5L223 201.1L224.7 200.4L291.9 166.8L293.2 166L294.1 165L294.3 163.9L299.3 163.9L299.3 186.9L298.8 188.6L297.5 190.3L295.4 191.6L228.2 225.2L225.5 226.3L222.3 226.9L218.8 227.2L215.4 226.9L212.2 226.3L209.4 225.2L104.6 172.8L102.5 171.4L101.2 169.8L100.7 168.1L100.7 145.1Z",
        "fo",
      ],
      [
        "M100.7 145.1L101.2 146.8L102.5 148.4L104.6 149.8L209.4 202.2L212.2 203.2L215.4 203.9L218.8 204.1L222.3 203.9L225.5 203.2L228.2 202.2L295.4 168.6L297.5 167.2L298.8 165.6L299.3 163.9",
        "lo",
      ],
      [
        "M105.7 145.1L105.9 146.2L106.8 147.2L108.1 148L212.9 200.4L214.6 201.1L216.7 201.5L218.8 201.7L221 201.5L223 201.1L224.7 200.4L291.9 166.8L293.2 166L294.1 165L294.3 163.9",
        "nf",
      ],
      [
        "M100.7 145.1L100.7 168.1L101.2 169.8L102.5 171.4L104.6 172.8L209.4 225.2L212.2 226.3L215.4 226.9L218.8 227.2L222.3 226.9L225.5 226.3L228.2 225.2L295.4 191.6L297.5 190.3L298.8 188.6L299.3 186.9L299.3 163.9",
        "sil",
      ],
    ],
  },
  /** A padlock: a section you are not allowed to see. */
  lock: {
    viewBox: "159 95 82 138",
    paths: [
      [
        "M161.1 142.6L162 140.3L164.6 138.3L173.1 134.1L177 132.8L181.6 132.3L186.2 132.8L190.1 134.1L235.4 156.7L238 158.7L238.9 160.9L238.9 219.8L238 222.1L235.4 224.1L226.9 228.3L223 229.6L218.4 230.1L213.8 229.6L209.9 228.3L164.6 205.7L162 203.7L161.1 201.5Z",
        "sil-plate",
      ],
      [
        "M235.7 160.9L235 162.6L233.1 164.1L224.6 168.3L221.8 169.3L218.4 169.6L215 169.3L212.2 168.3L166.9 145.7L165 144.2L164.3 142.6",
        "lo",
      ],
      [
        "M177.1 140.3L177.1 116.1L177.5 110.8L178.8 106.2L181 102.4L183.8 99.6L187.3 97.8L191.2 97.2L195.5 97.8L200 99.4L204.5 102.2L208.8 106L212.7 110.5L216.2 115.8L219.1 121.4L221.2 127.4L222.5 133.3L222.9 139L222.9 163.2L213.9 158.7L213.9 134.4L213.6 131L212.8 127.4L211.5 123.8L209.8 120.4L207.7 117.2L205.3 114.5L202.7 112.2L200 110.5L197.3 109.5L194.7 109.2L192.3 109.5L190.2 110.6L188.5 112.3L187.2 114.6L186.4 117.4L186.1 120.6L186.1 144.8Z",
        "sil-plate",
      ],
      [
        "M181.6 142.6L181.6 118.3L182 114.1L183 110.4L184.7 107.4L187 105.1L189.8 103.7L193 103.2L196.4 103.6L200 105L203.6 107.2L207 110.2L210.2 113.9L213 118.1L215.3 122.6L217 127.4L218 132.1L218.4 136.7L218.4 161",
        "lo",
      ],
      [
        "M192.1 186.5L191.7 184.1L190.7 181.6L189.1 179.6L187.3 178.2L185.4 177.7L183.9 178.2L182.8 179.6L182.5 181.7L182.8 184.1L183.9 186.6L185.4 188.6L187.3 190L189.1 190.5L190.7 190L191.7 188.6L192.1 186.5Z",
        "hi",
      ],
      ["M187.3 190L187.3 201.4", "hi"],
    ],
  },
} satisfies Record<string, Figure>;

export type SettingsIllustrationName = keyof typeof FIGURES;

/** One hairline figure, 88px tall; decorative, so hidden from assistive tech. */
export function SettingsIllustration({
  className,
  name,
}: {
  className?: string;
  name: SettingsIllustrationName;
}) {
  const figure: Figure = FIGURES[name];
  return (
    <svg
      aria-hidden
      viewBox={figure.viewBox}
      className={cn("h-14 w-auto overflow-visible", className)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {figure.paths.map(([d, stroke], i) => (
        <path
          // Paths never reorder: paint order is the drawing, so the index is a stable key.
          key={i}
          d={d}
          className={STROKE[stroke]}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
