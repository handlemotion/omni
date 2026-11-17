import type { UseQueryResult } from "@tanstack/react-query";
import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { IconBuildings } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { isNotFound } from "@/lib/api.ts";
import { colors, space } from "@/theme/tokens.ts";

/** A CRM record's screen: its name as the title, then `children` once it loads. */
export function RecordView<T>(props: {
  query: UseQueryResult<T>;
  title: (data: T) => string;
  children: (data: T) => ReactNode;
}) {
  const { query } = props;
  if (query.isPending) {
    return (
      <View style={styles.content}>
        <Skeleton width="60%" height={20} />
        <Skeleton width="40%" height={14} />
        <Skeleton width="80%" height={14} />
      </View>
    );
  }
  if (query.isError) {
    return isNotFound(query.error) ? (
      <EmptyState icon={IconBuildings} title="This record is gone" />
    ) : (
      <EmptyState icon={IconBuildings} title="This record didn't load">
        <Button intent="plain" label="Try again" onPress={() => void query.refetch()} />
      </EmptyState>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: props.title(query.data) }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
        {props.children(query.data)}
      </ScrollView>
    </>
  );
}

/** Labelled values; a field without a value is left out. */
export function Fields({
  fields,
}: {
  fields: [label: string, value: string | null | undefined][];
}) {
  const shown = fields.filter(([, value]) => value);
  if (!shown.length) return null;
  return (
    <View style={styles.fields}>
      {shown.map(([label, value]) => (
        <View key={label} style={styles.field}>
          <Text size="sm" tone="mutedForeground">
            {label}
          </Text>
          <Text selectable>{value}</Text>
        </View>
      ))}
    </View>
  );
}

/** A titled run of linked records; nothing when it has none. */
export function Section<T>(props: { title: string; items: T[]; render: (item: T) => ReactNode }) {
  if (!props.items.length) return null;
  return (
    <View style={styles.section}>
      <Text size="sm" weight="medium" tone="mutedForeground" style={styles.sectionTitle}>
        {props.title}
      </Text>
      {props.items.map((item, index) => (
        <View key={index} style={index > 0 ? styles.divided : null}>
          {props.render(item)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  scroll: { paddingBottom: space(12), gap: space(6) },
  fields: { paddingHorizontal: space(4), paddingTop: space(2), gap: space(4) },
  field: { gap: space(1) },
  section: { gap: space(1) },
  sectionTitle: { paddingHorizontal: space(4) },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
