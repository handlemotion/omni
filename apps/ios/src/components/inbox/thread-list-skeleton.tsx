import { StyleSheet, View } from "react-native";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { colors, gutter, radius, rowLead, space } from "@/theme/tokens.ts";

/** Rows shaped like thread rows, under a day's heading, while the first page is on its way. */
export function ThreadListSkeleton() {
  return (
    <View accessibilityLabel="Loading" accessible style={styles.list}>
      <View style={styles.heading}>
        <Skeleton width={56} height={13} />
      </View>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <View key={row} style={styles.row}>
          <View style={styles.avatar} />
          <View style={styles.body}>
            <Skeleton width="45%" height={16} />
            <Skeleton width="75%" height={13} />
            <Skeleton width="90%" height={13} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingTop: space(1) },
  heading: { paddingHorizontal: gutter, paddingTop: space(5), paddingBottom: space(2) },
  row: {
    flexDirection: "row",
    gap: space(3.5),
    paddingHorizontal: gutter,
    paddingVertical: space(3.5),
  },
  avatar: {
    width: rowLead,
    height: rowLead,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  body: { flex: 1, gap: space(2), paddingTop: space(0.5) },
});
