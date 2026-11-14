import { StyleSheet, View } from "react-native";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { colors, radius, space } from "@/theme/tokens.ts";

/** Rows shaped like thread rows, while the first page is on its way. */
export function ThreadListSkeleton() {
  return (
    <View accessibilityLabel="Loading" accessible>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <View key={row} style={styles.row}>
          <View style={styles.avatar} />
          <View style={styles.body}>
            <Skeleton width="45%" height={14} />
            <Skeleton width="80%" height={14} />
            <Skeleton width="65%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  avatar: { width: 40, height: 40, borderRadius: radius.full, backgroundColor: colors.accent },
  body: { flex: 1, gap: space(2), paddingTop: space(0.5) },
});
