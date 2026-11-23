import type { Thread } from "@omni/client";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  IconArchive,
  IconBellOff,
  IconChevronLeft,
  IconCircleCheck,
  IconClock,
  IconEllipsis,
  IconForward,
  IconInbox,
  IconMail,
  IconMailUnread,
  IconReply,
  IconReplyAll,
  IconTrash,
  IconWarning,
} from "@/components/icons.ts";
import { MenuRow, SheetDivider } from "@/components/shell/menu-row.tsx";
import { BarFade } from "@/components/ui/edge-blur.tsx";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { FloatingButton, FloatingGroup } from "@/components/ui/floating.tsx";
import { canReplyAll } from "@/lib/compose.ts";
import { floatingControl, space } from "@/theme/tokens.ts";
import { forward, listMessage, reply, type ThreadActions } from "./use-thread-actions.ts";

const SIDE = space(4);

/** Back and ⋯ in round 44pt slots, as the shell's top bar draws its ☰ and workspace. */
export function ThreadTopBar(props: {
  thread: Thread | undefined;
  page: string | undefined;
  actions: ThreadActions;
}) {
  const insets = useSafeAreaInsets();
  const sheet = useSheet();
  return (
    <View style={[styles.top, { paddingTop: insets.top + space(2) }]}>
      <FloatingButton
        icon={IconChevronLeft}
        label="Back"
        compact
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/mail"))}
      />
      {props.thread ? (
        <>
          <FloatingButton icon={IconEllipsis} label="More" compact onPress={sheet.open} />
          <MoreSheet
            thread={props.thread}
            page={props.page}
            actions={props.actions}
            sheet={sheet}
          />
        </>
      ) : null}
    </View>
  );
}

function MoreSheet(props: {
  thread: Thread;
  page: string | undefined;
  actions: ThreadActions;
  sheet: ReturnType<typeof useSheet>;
}) {
  const { thread, actions: act } = props;
  const id = thread.id;
  const inSpam = props.page === "spam";
  const list = listMessage(thread);
  const unsubscribed = act.unsubscribe.isSuccess || !!list?.unsubscribe.unsubscribed;
  const pick = (then: () => void) => () => props.sheet.pick(then);
  return (
    <BottomSheet
      isOpen={props.sheet.isOpen}
      onClose={props.sheet.close}
      onClosed={props.sheet.onClosed}
      title={thread.messages[0]?.subject || "(no subject)"}
    >
      <MenuRow
        icon={thread.read ? IconMailUnread : IconMail}
        muted
        label={thread.read ? "Mark as unread" : "Mark as read"}
        onPress={pick(() => act.markUnread.mutate({ threadId: id, read: !thread.read }))}
      />
      {thread.archived ? null : (
        <MenuRow icon={IconArchive} muted label="Archive" onPress={pick(() => act.archive(id))} />
      )}
      <SheetDivider />
      {list && !unsubscribed ? (
        <MenuRow
          icon={IconBellOff}
          muted
          label="Unsubscribe"
          onPress={pick(() => act.leaveList(id, list))}
        />
      ) : null}
      <MenuRow
        icon={inSpam ? IconInbox : IconWarning}
        muted
        label={inSpam ? "Not spam" : "Report spam"}
        onPress={pick(() => act.spam(id, !inSpam))}
      />
      {props.page === "trash" ? null : (
        <>
          <SheetDivider />
          <MenuRow
            icon={IconTrash}
            destructive
            label="Move to trash"
            onPress={pick(() => act.trash(id))}
          />
        </>
      )}
    </BottomSheet>
  );
}

/**
 * Two flat pills floating over the bottom edge, the page fading out behind them: Reply, Reply
 * all and Forward; Later, Done and Trash.
 */
export function ThreadBottomBar(props: {
  thread: Thread;
  page: string | undefined;
  actions: ThreadActions;
}) {
  const insets = useSafeAreaInsets();
  const { thread, actions: act } = props;
  const id = thread.id;
  const bottom = Math.max(insets.bottom - space(1), SIDE);
  return (
    <>
      <BarFade middle={bottom + floatingControl / 2} />
      <View pointerEvents="box-none" style={[styles.bottom, { paddingBottom: bottom }]}>
        <FloatingGroup
          actions={[
            { icon: IconReply, label: "Reply", onPress: () => reply(id, false) },
            {
              icon: IconReplyAll,
              label: "Reply all",
              onPress: canReplyAll(thread) ? () => reply(id, true) : undefined,
            },
            { icon: IconForward, label: "Forward", onPress: () => forward(id) },
          ]}
        />
        <FloatingGroup
          actions={[
            {
              icon: IconClock,
              label: thread.later ? "Back to inbox" : "Later",
              onPress: () => act.later(id, !thread.later),
            },
            {
              icon: IconCircleCheck,
              label: thread.done ? "Not done" : "Done",
              onPress: () => act.toggleDone(thread),
            },
            {
              icon: IconTrash,
              label: "Move to trash",
              onPress: props.page === "trash" ? undefined : () => act.trash(id),
            },
          ]}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: SIDE,
    paddingBottom: space(2.5),
  },
  bottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: SIDE,
  },
});
