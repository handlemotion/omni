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
  /** `primary` at 12% on white, as `--primary-subtle` mixes it. */
  primarySubtle: "#e4eefc",
  danger: "#ef2a51",
  dangerForeground: "#ffffff",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * The web scale (`--text-xs`, `--text-sm`, `--text-lg`) plus `md`, a phone's reading size for
 * list rows and message bodies, between `sm` and `lg`.
 */
export const text = {
  xs: { fontSize: 11, lineHeight: 13 },
  sm: { fontSize: 13, lineHeight: 16 },
  md: { fontSize: 15, lineHeight: 20 },
  lg: { fontSize: 17, lineHeight: 21 },
  /** A screen's title. */
  title: { fontSize: 22, lineHeight: 28 },
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

/** `--shadow-raised`: a crisp 1px drop in the foreground's ink. */
export const shadowRaised = {
  shadowColor: "#171717",
  shadowOpacity: 0.06,
  shadowRadius: 2,
  shadowOffset: { width: 0, height: 1 },
} as const;
