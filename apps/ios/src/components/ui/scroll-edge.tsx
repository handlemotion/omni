import { createContext, useContext } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

type OnScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/**
 * Hears where a page's list is scrolled, so chrome over it (the shell's top bar) can show its
 * edge once rows pass under it. Lists read it; a page provides it.
 */
export const ScrollEdge = createContext<OnScroll | undefined>(undefined);

/** The page's scroll listener, for a list to pass as `onScroll`. */
export const useScrollEdge = () => useContext(ScrollEdge);
