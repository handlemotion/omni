import { StyleSheet, View } from "react-native";
import { gutter, radius, rowLead, space } from "@/theme/tokens.ts";
import { Skeleton } from "./skeleton.tsx";

/**
 * Rows shaped like `ItemRow`, while a list's first page is on its way. It sits in the flow of a
 * sheet; a page under the native header wraps it in `LoadingPage`.
 */
export function ListSkeleton({ round = false }: { round?: boolean }) {
  return (
    <View accessibilityLabel="Loading" accessible style={styles.list}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
        <View key={row} style={styles.row}>
          <Skeleton
            width={rowLead}
            height={rowLead}
            round={round}
            corner={round ? undefined : radius.field}
          />
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
  body: { flex: 1, gap: space(2) },
});
