# Components

Rodrigo's. How the design system is organized and the rules for using it: `DESIGN.md` at the repo
root. In short: `ui/` holds the adapted Intent UI primitives, `icons/` the Figma icons, and each
feature folder (`auth/`, ...) composes them. Components consume `src/hooks` and never call
`src/lib`'s API client directly.
