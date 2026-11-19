import { StyleSheet, View } from "react-native";
import { colors, gutter, radius, rowLead, space } from "@/theme/tokens.ts";
import { Skeleton } from "./skeleton.tsx";

/** Rows shaped like `ItemRow`, while a list's first page is on its way. */
export function ListSkeleton({ round = false }: { round?: boolean }) {
  return (
    <View accessibilityLabel="Loading" accessible style={styles.list}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
        <View key={row} style={styles.row}>
          <View style={[styles.lead, round && styles.round]} />
          <View style={styles.body}>
            <Skeleton width="55%" height={16} />
            <Skeleton width="30%" height={13} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingTop: space(1) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    paddingHorizontal: gutter,
    paddingVertical: space(3.5),
  },
  lead: {
    width: rowLead,
    height: rowLead,
    borderRadius: radius.field,
    backgroundColor: colors.accent,
  },
  round: { borderRadius: radius.full },
  body: { flex: 1, gap: space(2) },
});
