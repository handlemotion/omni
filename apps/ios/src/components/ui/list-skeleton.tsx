import { StyleSheet, View } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Skeleton } from "./skeleton.tsx";

/** One-line rows with a leading glyph, while a list's first page is on its way. */
export function ListSkeleton() {
  return (
    <View accessibilityLabel="Loading" accessible>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
        <View key={row} style={styles.row}>
          <View style={styles.glyph} />
          <View style={styles.body}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="30%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  glyph: { width: 32, height: 32, borderRadius: radius.lg, backgroundColor: colors.accent },
  body: { flex: 1, gap: space(1.5) },
});
