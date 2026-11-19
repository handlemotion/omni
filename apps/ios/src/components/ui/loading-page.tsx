import { useEffect, useRef, type ReactNode } from "react";
import { Animated, ScrollView, StyleSheet } from "react-native";

const QUICK_LOAD_MS = 150;

/**
 * A page's placeholder while its first answer is on its way. It sits in a scroll view that
 * adjusts for the native header, as the list that replaces it does, so the placeholder starts
 * exactly where the rows will (not under a large title) and nothing jumps when they arrive. It
 * fades in only after a short wait.
 */
export function LoadingPage({ children }: { children: ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const appear = Animated.timing(opacity, {
      toValue: 1,
      duration: 200,
      delay: QUICK_LOAD_MS,
      useNativeDriver: true,
    });
    appear.start();
    return () => appear.stop();
  }, [opacity]);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      scrollEnabled={false}
      contentContainerStyle={styles.fill}
      accessibilityLabel="Loading"
      accessible
    >
      <Animated.View style={{ opacity }}>{children}</Animated.View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ fill: { flexGrow: 1 } });
