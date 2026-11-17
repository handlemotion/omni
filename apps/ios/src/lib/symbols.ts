import type { ComponentProps } from "react";
import type { Stack } from "expo-router";

/**
 * An SF Symbol name. Native chrome (the tab bar, header menus) draws SF Symbols, the platform's
 * own glyphs; everything the app draws itself uses Central Icons (`components/icons.ts`).
 */
export type SymbolName = NonNullable<ComponentProps<typeof Stack.Toolbar.MenuAction>["icon"]>;
