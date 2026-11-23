export const colors = {
  /** The main app canvas. */
  background: "#ffffff",
  /** The left navigation drawer and welcome canvas. */
  sidebar: "#fafafa",
  /** Anything raised on the canvas: cards, sheets, buttons, the search field. */
  surface: "#ffffff",
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
  /** `--brand-cream`: the Omni globe mark without a tile, as on the web sign-in page. */
  brandCream: "#dcc7a8",
  /** `primary` at 12% on white, as `--primary-subtle` mixes it. */
  primarySubtle: "#e4eefc",
  /** Each module's mark (`--module-*`): its tile behind a white filled glyph. */
  moduleMail: "#1d72e8",
  moduleDrive: "#15924f",
  moduleCrm: "#7a4fd1",
  moduleCalendar: "#ef4444",
  moduleForeground: "#ffffff",
  /** What dims the page under a sheet: the foreground at 18%. */
  scrim: "rgba(23, 23, 23, 0.18)",
  danger: "#ef2a51",
  dangerForeground: "#ffffff",
  /** `--success`: Done, as a row's swipe shows it. */
  success: "#009966",
  successForeground: "#ffffff",
  /** `--warning`: Later, as a row's swipe shows it. */
  warning: "#ffb900",
  warningForeground: "#461901",
  /** A conversation's page swiped right for Done: a solid, lighter green under white ink. */
  swipeDone: "#34c46e",
  /** A conversation's page swiped left for Later: a solid grey, not the list's amber. */
  swipeLater: "#8e8e93",
  /** The label and badge drawn on a swipe's fill. */
  swipeForeground: "#ffffff",
  /** `--tooltip`: dark surface behind code card previews. */
  tooltip: "#2b2b2b",
  /** `--chart-3`: `primary` mixed 60% into white, for keywords on code card previews. */
  chart3: "#7dadf5",
  /** `mutedForeground` at 45%, for audio card waveform bars. */
  waveform: "rgba(133, 133, 133, 0.45)",
  /** A folder card's pocket (`folder-art.tsx`), mirroring `--folder-*` on the web. */
  folderBackTop: "#efefef",
  folderBackBottom: "#e2e2e2",
  folderFrontTop: "rgba(250, 250, 250, 0.86)",
  folderFrontBottom: "rgba(242, 242, 242, 0.94)",
  folderEdge: "#e2e2e2",
  folderShine: "rgba(255, 255, 255, 0.75)",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * The phone's type scale. Larger than the web's (`--text-*`), with air between lines: a list's
 * row reads at `md` (iOS body size), its detail at `sm`, a screen's own heading at `title`, and
 * the big left-aligned name at the top of a record or conversation at `display`.
 */
export const text = {
  xs: { fontSize: 11, lineHeight: 15 },
  sm: { fontSize: 13, lineHeight: 18 },
  /** A section's heading in a list, a row's time. */
  caption: { fontSize: 12, lineHeight: 16 },
  /** A thread row's subject. */
  subhead: { fontSize: 14, lineHeight: 19 },
  /** A thread row's sender, a menu row's label, the search pill, buttons. */
  body: { fontSize: 15, lineHeight: 20 },
  md: { fontSize: 16, lineHeight: 21 },
  lg: { fontSize: 18, lineHeight: 24 },
  /** A message's text in a conversation: the body size, with room between its lines. */
  reading: { fontSize: 15, lineHeight: 22 },
  /** A conversation's subject. */
  heading: { fontSize: 23, lineHeight: 29, letterSpacing: -0.4 },
  /** A record's name. */
  title: { fontSize: 25, lineHeight: 31, letterSpacing: -0.4 },
  /** The sign-in heading. */
  display: { fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
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
  /** A ghost button in a toolbar (a conversation's properties). */
  control: 10,
  field: 12,
  row: 14,
  card: 16,
  /** A bottom sheet's top corners. */
  sheet: 28,
  /** The phone's display corner: a whole page lifted off as a card (a conversation's swipe). */
  screen: 44,
  full: 999,
} as const;

/** The Tailwind spacing scale in points (1 = 4pt). */
export const space = (steps: number) => steps * 4;

/** `--spacing-icon` and the larger glyph touch targets use. */
export const iconSize = { sm: 15, field: 18, md: 20, menu: 22, lg: 24 } as const;

/** A list row's leading avatar or tile, and the gutter every screen keeps from its edges. */
export const rowLead = 44;
/** The floating bar's round buttons and its search pill (matches login's 48pt buttons). */
export const floatingControl = 48;
/** The bar's controls while its field is open over the keyboard. */
export const searchControl = 44;
/** The fade behind the floating bar and module dock, where the page dissolves before them. */
export const floatingFade = 176;
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
