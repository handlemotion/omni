import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** The system's Reduce Motion setting, live: motion that moves things jumps to its end instead. */
export function useReduceMotion() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);
  return still;
}
