export const colors = {
  /** The app canvas. */
  background: "#ffffff",
  /** Anything raised on the canvas: cards, sheets, the search field. */
  surface: "#fdfdfd",
  foreground: "#171717",
  mutedForeground: "#858585",
  subtleForeground: "#a6a6a6",
  border: "#e8e8e8",
  /** The current item's fill. */
  accent: "#f3f3f3",
  /** A well: sunk one step into its surface (fields). */
  well: "#f0f0f0",
  primary: "#1d72e8",
  primaryButton: "#1a7ef5",
  primaryForeground: "#ffffff",
  /** A logo's tile, as `--logo-tile`. */
  logoTile: "#ffffff",
  /** `primary` at 12% on white, as `--primary-subtle` mixes it. */
  primarySubtle: "#e4eefc",
  danger: "#ef2a51",
  dangerForeground: "#ffffff",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * The phone's type scale. Larger than the web's (`--text-*`), with air between lines: a list's
 * row reads at `md` (iOS body size), its detail at `sm`, a screen's own heading at `title`, and
 * the big left-aligned name at the top of a record or conversation at `display`.
 */
export const text = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 19 },
  md: { fontSize: 17, lineHeight: 23 },
  lg: { fontSize: 20, lineHeight: 26 },
  /** A conversation's subject, a record's name. */
  title: { fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  /** The sign-in heading. */
  display: { fontSize: 34, lineHeight: 41, letterSpacing: -0.6 },
} as const;

export type TextSize = keyof typeof text;

/** Inter, as on the web (`--font-sans`), loaded in the root layout. */
export const fonts = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
} as const;

export type FontWeight = keyof typeof fonts;

/** `--radius-*`, plus the rounder shapes a touch screen wants for fields and rows. */
export const radius = { sm: 4, lg: 6, xl: 8, field: 12, card: 16, full: 999 } as const;

/** The Tailwind spacing scale in points (1 = 4pt). */
export const space = (steps: number) => steps * 4;

/** `--spacing-icon` and the larger glyph touch targets use. */
export const iconSize = { sm: 15, md: 20, lg: 24 } as const;

/** A list row's leading avatar or tile, and the gutter every screen keeps from its edges. */
export const rowLead = 44;
export const gutter = space(5);

/** `--shadow-raised`: a crisp 1px drop in the foreground's ink. */
export const shadowRaised = {
  shadowColor: "#171717",
  shadowOpacity: 0.06,
  shadowRadius: 2,
  shadowOffset: { width: 0, height: 1 },
} as const;
