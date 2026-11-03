# Omni design

Read this before you design or build any UI. It says where the design system lives and how to use
it. It holds no values: colors, sizes, and radii live in code, so they cannot drift from here.

## Sources of truth

| What               | Where                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| The designs        | Figma, file [Omni](https://www.figma.com/design/TdBkazABvzieUn4TYp5wQk/Omni). Implement from it; when code and Figma disagree, ask. |
| Tokens             | `apps/web/src/styles.css`. Raw values in `:root`, exposed to Tailwind as semantic classes in `@theme inline`.                       |
| Primitives         | `apps/web/src/components/ui/`: Intent UI components (React Aria + Tailwind), adapted to our tokens. Added with the shadcn CLI.      |
| Icons              | `apps/web/src/components/icons/`: SVGs exported from Figma, wrapped as components.                                                  |
| Feature components | `apps/web/src/components/<feature>/` (for example `auth/`): compositions of primitives. Routes render these and stay thin.          |
| Registry config    | `apps/web/components.json`. Add a primitive with `npx shadcn@latest add @intentui/<name>` from `apps/web`.                          |

## Rules

- **Never invent.** Build only what the Figma frame shows: no added text, borders, rings,
  shadows, opacity, offsets or sizes. Take every value from the frame (`get_design_context`) and
  check the result against Figma's own render, pixel for pixel. A state the frame doesn't show
  (error, sent, loading) is a question for the designer, not something to fill in.
- **Always use components.** Build from `components/ui` primitives. No raw `<button>`, `<input>`
  or hand-styled boxes in feature code. If a primitive can't express the design, change the
  primitive (a new variant or size) so every screen gets it, rather than overriding it in place.
- **Only semantic classes.** Use the token classes (`bg-background`, `bg-surface`,
  `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `size-icon`, ...).
  Never hex values, arbitrary colors, or Tailwind palette colors (`gray-200`) in components.
- **Add a token only when a design uses it.** A new value goes into `styles.css` first, named for
  its role, not its look. Keep the file short.
- **Background vs. surface.** `background` is the app canvas. `surface` is anything raised on it:
  cards, popovers, sidebars.
- **Brand.** `primary` is the brand color: primary buttons and selected/active components, with
  `primary-foreground` text on it. Use it sparingly; most controls are neutral.
- **Inputs stay calm.** Focus shows as a `ring`-colored border only: no glow, no tint.
- **Control sizes.** Buttons and inputs share a size scale: `md` is the default, `lg` the larger
  one. Pick the size the frame shows; don't resize a control with classes.
- **Destructive actions.** `<Button intent="danger">`: filled red with a darker edge. Use it only
  for actions that delete or can't be undone, and say what happens on the button itself.
- **Multi-step flows.** `Steps` / `Step` (`components/ui/steps.tsx`): one step open at a time,
  finished steps collapse to their answer, upcoming steps are dimmed.
- **Inset actions.** An action inside a field (submit arrow, clear, reveal) is
  `<Button size="inset">` placed in an `InputGroup`; the group handles position and padding.
- **Balanced padding.** Equal padding on opposite sides of a container, and the same gap between
  siblings of the same kind. Take spacing from the Tailwind scale.
- **Optical alignment.** Center things where they look centered, not where the math puts them
  (a card sits slightly above the true middle; an icon aligns to the text's cap height). When you
  nudge for optics, leave a short comment saying so.
- **Loading.** Data that's on its way renders with `skullet` (`import { Skeleton } from "skullet/react"`),
  never a spinner or a skeleton div. An action in progress is `<Button isPending>`: it dims like a
  disabled button, a spinner takes the icon's place, and a text-only button shimmers its text.
- **Hover and current.** Icons are muted by default and turn `foreground` on hover. The item for
  the page you're on is _current_ (`isCurrent`, which sets `aria-current="page"`): foreground icon
  and the `accent` fill. "Selected" is for picking items in a list, not for navigation.
- **Weight.** Text is regular weight unless the design shows otherwise.
- **Numbers.** Counts, times and anything that lines up in a column use `tabular-nums`, so digits
  don't shift as values change.
