import { ScrollView, StyleSheet, View } from "react-native";
import { useTopInset } from "@/components/shell/menu-nav.ts";
import { IconClock } from "@/components/icons.ts";
import { AvatarTile } from "@/components/ui/avatar-tile.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useMailboxes, useThreads } from "@/lib/mail.ts";
import { useRecentSearches } from "@/lib/recent-searches.ts";
import { useSession } from "@/lib/session.ts";
import { colors, gutter, iconSize, space } from "@/theme/tokens.ts";

const PEOPLE = 4;
const FACE = space(13);
const FACE_SLOT = space(16);

interface Person {
  name: string;
  address: string;
}

function useLatestInboxSenders() {
  const threads = useThreads("inbox", undefined);
  const mailboxes = useMailboxes();
  const email = useSession().data?.user.email;
  const own = new Set(
    [email, ...(mailboxes.data ?? []).map((m) => m.address)]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  );
  const people: Person[] = [];
  for (const thread of threads.data ?? []) {
    const from = thread.latestFrom;
    if (!from?.address) continue;
    const key = from.address.toLowerCase();
    if (own.has(key) || people.some((p) => p.address.toLowerCase() === key)) continue;
    people.push({ name: from.name || from.address, address: from.address });
    if (people.length === PEOPLE) break;
  }
  return people;
}

/**
 * The open search before anything is typed: the people who wrote in last, then this phone's
 * recent searches. A tap on either searches for it.
 */
export function SearchStart({ onSearch }: { onSearch: (q: string) => void }) {
  const people = useLatestInboxSenders();
  const recent = useRecentSearches();
  const inset = useTopInset();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.page, { paddingTop: inset }]}
    >
      {people.length ? (
        <>
          <Heading label="People" />
          <View style={styles.people}>
            {people.map((person) => (
              <AvatarTile
                key={person.address}
                name={person.name}
                logo={{ address: person.address }}
                size={FACE}
                width={FACE_SLOT}
                label={`Search ${person.name}`}
                onPress={() => onSearch(person.address)}
              />
            ))}
          </View>
        </>
      ) : null}
      {recent.length ? (
        <>
          <Heading label="Recent" spaced={people.length > 0} />
          {recent.map((q) => (
            <PressableRow key={q} style={styles.recent} onPress={() => onSearch(q)}>
              <IconClock size={iconSize.field} color={colors.mutedForeground} />
              <Text size="body" numberOfLines={1} style={styles.grow}>
                {q}
              </Text>
            </PressableRow>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function Heading({ label, spaced = false }: { label: string; spaced?: boolean }) {
  return (
    <Text
      size="caption"
      weight="medium"
      tone="subtleForeground"
      accessibilityRole="header"
      style={[styles.heading, spaced && styles.spaced]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  page: { gap: space(2) },
  people: {
    flexDirection: "row",
    gap: space(4),
    paddingHorizontal: gutter,
    paddingTop: space(1),
    paddingBottom: space(2.5),
  },
  heading: { paddingHorizontal: gutter },
  spaced: { paddingTop: space(2) },
  recent: { height: space(11), alignItems: "center", gap: space(3), paddingVertical: 0 },
  grow: { flex: 1, minWidth: 0 },
});
