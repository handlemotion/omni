import { storedToggle } from "../lib/stored-preference.ts";

/** `[fullScreen, toggle]`. Side by side unless the person chose full screen. */
export const useFullScreen = storedToggle("omni:full-screen");
