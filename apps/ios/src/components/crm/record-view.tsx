import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { IconBuildings } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { LoadingPage } from "@/components/ui/loading-page.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { isNotFound } from "@/lib/api.ts";
import type { LogoFor } from "@/lib/sender-logo.ts";
import { gutter, space } from "@/theme/tokens.ts";

/** What a record's top shows: its name, large, and the line under it. */
export interface RecordHead {
  name: string;
  detail?: string | null;
  logo?: LogoFor | null;
  /** It is archived: a badge says so under its name. */
  archived?: boolean;
}

/**
 * A CRM record's screen: its avatar and name, large and wrapping, at the top of the page (the
 * header keeps only the back button), then `children` once it loads.
 */
export function RecordView<T>(props: {
  query: UseQueryResult<T>;
  head: (data: T) => RecordHead;
  children: (data: T) => ReactNode;
}) {
  const { query } = props;
  if (query.isPending) {
    return (
      <LoadingPage>
        <View style={styles.head}>
          <Skeleton width={64} height={64} round />
          <Skeleton width="70%" height={28} />
          <Skeleton width="40%" height={16} />
        </View>
      </LoadingPage>
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
  const head = props.head(query.data);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
      <View style={styles.head}>
        <Avatar name={head.name} logo={head.logo} size={64} />
        <Text size="title" weight="medium" accessibilityRole="header" selectable>
          {head.name}
        </Text>
        {head.detail ? (
          <Text tone="mutedForeground" selectable>
            {head.detail}
          </Text>
        ) : null}
        {head.archived ? <Badge label="Archived" /> : null}
      </View>
      {props.children(query.data)}
    </ScrollView>
  );
}

/** A field's value; `href` makes it a link (mail, phone, web) that opens in its app. */
export type FieldValue = string | { text: string; href: string };

/** Labelled values; a field without a value is left out, and a field may hold several. */
export function Fields({
  fields,
}: {
  fields: [label: string, value: FieldValue | FieldValue[] | null | undefined][];
}) {
  const shown = fields
    .map(
      ([label, value]) =>
        [label, (Array.isArray(value) ? value : [value]).filter(isValue)] as const,
    )
    .filter(([, values]) => values.length);
  if (!shown.length) return null;
  return (
    <View style={styles.fields}>
      {shown.map(([label, values]) => (
        <View key={label} style={styles.field}>
          <Text size="sm" tone="mutedForeground">
            {label}
          </Text>
          {values.map((value) =>
            typeof value === "string" ? (
              <Text key={value} selectable>
                {value}
              </Text>
            ) : (
              <Text
                key={value.href}
                tone="primary"
                accessibilityRole="link"
                suppressHighlighting={false}
                onPress={() => void Linking.openURL(value.href)}
              >
                {value.text}
              </Text>
            ),
          )}
        </View>
      ))}
    </View>
  );
}

const isValue = (value: FieldValue | null | undefined): value is FieldValue =>
  typeof value === "string" ? value.trim().length > 0 : !!value?.text;

/** A titled run of linked records; nothing when it has none. */
export function Section<T>(props: { title: string; items: T[]; render: (item: T) => ReactNode }) {
  if (!props.items.length) return null;
  return (
    <View>
      <SectionHeading label={props.title} />
      {props.items.map((item, index) => (
        <View key={index}>{props.render(item)}</View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: space(16), gap: space(6) },
  head: {
    paddingHorizontal: gutter,
    paddingTop: space(2),
    gap: space(2),
  },
  fields: { paddingHorizontal: gutter, gap: space(5) },
  field: { gap: space(1) },
});
