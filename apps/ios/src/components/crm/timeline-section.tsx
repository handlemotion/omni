import { Link, router } from "expo-router";
import type { ComponentType, ReactNode } from "react";
import { Alert, StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { IconFileText, IconMail, IconNote, IconTimelineEvent } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { useDeleteNote, type CrmRecordKind } from "@/lib/crm-mutations.ts";
import {
  contractVerb,
  eventText,
  useMe,
  useMemberNames,
  useStages,
  useTimeline,
  type CrmStage,
  type CrmTimelineItem,
} from "@/lib/crm-timeline.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { openNote } from "./record-actions.tsx";

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type Glyph = ComponentType<SvgProps & { size?: number }>;

/**
 * A record's timeline, as the web's Timeline tab shows it: mail, notes, contracts and changes,
 * newest first, with Add note. Your own notes open to edit, and hold a menu to delete.
 */
export function TimelineSection({ kind, id }: { kind: CrmRecordKind; id: string }) {
  const timeline = useTimeline(kind, id);
  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text size="sm" weight="medium" tone="mutedForeground" style={styles.title}>
          Timeline
        </Text>
        <Button intent="quiet" label="Add note" onPress={() => openNote(kind, id)} />
      </View>
      {timeline.isPending ? (
        <TimelineSkeleton />
      ) : timeline.isError && !timeline.data ? (
        <View style={styles.failed}>
          <Text size="sm" tone="mutedForeground">
            The timeline didn't load
          </Text>
          <Button intent="quiet" label="Try again" onPress={() => void timeline.refetch()} />
        </View>
      ) : (
        <Items kind={kind} id={id} items={timeline.data} />
      )}
      {timeline.hasNextPage ? (
        <View style={styles.more}>
          <Button
            intent="plain"
            label="Show older"
            isPending={timeline.isFetchingNextPage}
            onPress={() => void timeline.fetchNextPage()}
          />
        </View>
      ) : null}
    </View>
  );
}

function Items(props: { kind: CrmRecordKind; id: string; items: CrmTimelineItem[] }) {
  const names = useMemberNames().data;
  const stages = useStages().data;
  const me = useMe().data?.id;
  const who = (memberId: string | null) =>
    memberId ? (names?.get(memberId) ?? "A former member") : "Someone";
  return (
    <View style={styles.items}>
      {props.items.map((item) => (
        <Item
          key={`${item.kind}:${item.id}`}
          item={item}
          who={who}
          stages={stages}
          mine={item.kind === "note" && !!me && item.note.authorMemberId === me}
          record={props}
        />
      ))}
    </View>
  );
}

function Item(props: {
  item: CrmTimelineItem;
  who: (memberId: string | null) => string;
  stages: CrmStage[] | undefined;
  mine: boolean;
  record: { kind: CrmRecordKind; id: string };
}) {
  const { item, who } = props;
  switch (item.kind) {
    case "note":
      return (
        <Line icon={IconNote} at={item.at} actor={who(item.note.authorMemberId)}>
          <NoteCard
            body={item.note.body}
            mine={props.mine}
            record={props.record}
            noteId={item.note.id}
          />
        </Line>
      );
    case "thread": {
      const from = item.thread.latestFrom;
      return (
        <Line
          icon={IconMail}
          at={item.at}
          actor={from?.name || from?.address || "Mail"}
          verb="wrote"
        >
          <PressableRow
            shape="inset"
            style={styles.cardFrame}
            onPress={() =>
              router.push({ pathname: "/mail/thread/[id]", params: { id: item.thread.id } })
            }
          >
            <View style={styles.cardBody}>
              <Text size="sm" numberOfLines={1}>
                {item.thread.subject || "(no subject)"}
              </Text>
              <Text size="xs" tone="mutedForeground" numberOfLines={1}>
                {item.thread.snippet}
              </Text>
            </View>
          </PressableRow>
        </Line>
      );
    }
    case "activity": {
      const { activity } = item;
      const verb = activity.direction === "out" ? "wrote to them" : "heard from them";
      return (
        <Line
          icon={IconMail}
          at={item.at}
          actor={activity.mailbox.name}
          verb={activity.subject ? `${verb} · ${activity.subject}` : verb}
        />
      );
    }
    case "contract":
      return (
        <Line
          icon={IconFileText}
          at={item.at}
          actor={who(item.contract.actorMemberId)}
          verb={`${contractVerb(item.contract)} ${item.contract.title}`}
        />
      );
    case "event": {
      const said = eventText(item.event, props.stages);
      if (!said) return null;
      return (
        <Line
          icon={IconTimelineEvent}
          at={item.at}
          actor={who(item.event.actorMemberId)}
          verb={said}
        />
      );
    }
  }
}

function Line(props: {
  icon: Glyph;
  at: string;
  actor: string;
  verb?: string;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <View style={styles.line}>
      <View style={styles.lineHead}>
        <View style={styles.glyph}>
          <Icon size={iconSize.sm} color={colors.mutedForeground} />
        </View>
        <Text size="sm" numberOfLines={1} style={styles.lineText}>
          {props.actor}
          {props.verb ? <Text size="sm" tone="mutedForeground">{` ${props.verb}`}</Text> : null}
        </Text>
        <Text size="xs" tone="mutedForeground" tabular>
          {WHEN.format(new Date(props.at))}
        </Text>
      </View>
      {props.children ? <View style={styles.lineBody}>{props.children}</View> : null}
    </View>
  );
}

function NoteCard(props: {
  body: string;
  mine: boolean;
  noteId: string;
  record: { kind: CrmRecordKind; id: string };
}) {
  const remove = useDeleteNote();
  const card = (
    <Text size="sm" selectable={!props.mine}>
      {props.body}
    </Text>
  );
  if (!props.mine) return <View style={styles.card}>{card}</View>;
  const { kind, id } = props.record;
  const confirmDelete = () =>
    Alert.alert("Delete note?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete note",
        style: "destructive",
        onPress: () =>
          remove.mutate(props.noteId, {
            onError: (error) => crmErrorAlert(error, "The note was not deleted"),
          }),
      },
    ]);
  return (
    <Link
      href={{ pathname: "/crm/note", params: { record: kind, id, noteId: props.noteId } }}
      asChild
    >
      <Link.Trigger>
        <PressableRow shape="inset" style={styles.cardFrame} accessibilityHint="Edit note">
          <View style={styles.cardBody}>{card}</View>
        </PressableRow>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction
          title="Edit note"
          icon="pencil"
          onPress={() => openNote(kind, id, props.noteId)}
        />
        <Link.MenuAction title="Delete note" icon="trash" destructive onPress={confirmDelete} />
      </Link.Menu>
    </Link>
  );
}

function TimelineSkeleton() {
  return (
    <View accessible accessibilityLabel="Loading the timeline" style={styles.items}>
      {[45, 60, 35, 55].map((width) => (
        <View key={width} style={styles.lineHead}>
          <View style={styles.glyph} />
          <Skeleton width={`${width}%`} height={12} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space(2) },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: space(4) },
  title: { flex: 1 },
  failed: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(4),
  },
  items: { gap: space(4), paddingHorizontal: space(4) },
  more: { paddingHorizontal: space(4), alignItems: "flex-start" },
  line: { gap: space(2) },
  lineHead: { flexDirection: "row", alignItems: "center", gap: space(2) },
  glyph: {
    width: 20,
    height: 20,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  lineText: { flex: 1 },
  lineBody: { paddingLeft: space(7) },
  cardFrame: {
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  card: {
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardBody: { flex: 1, gap: space(0.5) },
});
