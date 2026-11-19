export const colors = {
  /** The app canvas. */
  background: "#ffffff",
  /** Anything raised on the canvas: cards, sheets, the search field. */
  surface: "#fdfdfd",
  foreground: "#171717",
  mutedForeground: "#858585",
  subtleForeground: "#a6a6a6",
  border: "#e8e8e8",
  /** `--hairline-line`: a stronger line (a sheet's grabber, a disabled chevron). */
  hairlineLine: "#d9d9d9",
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
  /** Each module's mark (`--module-*`): its tile behind a white filled glyph. */
  moduleMail: "#1d72e8",
  moduleDrive: "#15924f",
  moduleCrm: "#7a4fd1",
  moduleForeground: "#ffffff",
  /** What dims the page under a sheet: the foreground at 18%. */
  scrim: "rgba(23, 23, 23, 0.18)",
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
  /** A section's heading in a list, a row's time. */
  caption: { fontSize: 13, lineHeight: 17 },
  /** A thread row's subject. */
  subhead: { fontSize: 15, lineHeight: 20 },
  /** A thread row's sender, a menu row's label, the search pill. */
  body: { fontSize: 16, lineHeight: 21 },
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
export const radius = {
  sm: 4,
  lg: 6,
  tile: 7,
  xl: 8,
  field: 12,
  row: 14,
  card: 16,
  /** A bottom sheet's top corners. */
  sheet: 28,
  full: 999,
} as const;

/** The Tailwind spacing scale in points (1 = 4pt). */
export const space = (steps: number) => steps * 4;

/** `--spacing-icon` and the larger glyph touch targets use. */
export const iconSize = { sm: 15, field: 18, md: 20, menu: 22, lg: 24 } as const;

/** A list row's leading avatar or tile, and the gutter every screen keeps from its edges. */
export const rowLead = 44;
/** The floating bar's round buttons and its search pill. */
export const floatingControl = 50;
/** The bar's controls while its field is open over the keyboard. */
export const searchControl = 48;
/** The fade behind the floating bar, where the page dissolves before it. */
export const floatingFade = 128;
/** The dot beside an unread thread's sender, or on the bell. */
export const unreadDot = 7;
export const gutter = space(5);

/** `--shadow-raised`: a crisp 1px drop in the foreground's ink. */
export const shadowRaised = {
  shadowColor: "#171717",
  shadowOpacity: 0.06,
  shadowRadius: 2,
  shadowOffset: { width: 0, height: 1 },
} as const;
