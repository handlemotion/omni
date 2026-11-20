import { Stack, router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { IconBuildings, IconChecklist, IconHandshake, IconUserRound } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { CheckCircle } from "@/components/ui/check-circle.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { LoadingPage } from "@/components/ui/loading-page.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { isNotFound } from "@/lib/api.ts";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { useMemberNames } from "@/lib/crm-timeline.ts";
import {
  DUE_CHOICES,
  dueIn,
  dueLabel,
  taskRecord,
  useDeleteTask,
  useTask,
  useUpdateTask,
  type CrmTask,
  type TaskChange,
} from "@/lib/crm-tasks.ts";
import { gutter, space, text } from "@/theme/tokens.ts";
import { Fields } from "./record-view.tsx";

const TITLE_MAX = 500;
const BODY_MAX = 20_000;
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

const RECORD_ICON = {
  "/crm/company/[id]": IconBuildings,
  "/crm/person/[id]": IconUserRound,
  "/crm/deal/[id]": IconHandshake,
};

/** One task: its check, title and notes, who has it, when it's due and what it's on. */
export function TaskScreen({ id }: { id: string }) {
  const query = useTask(id);
  if (query.isPending) {
    return (
      <LoadingPage>
        <View style={styles.head}>
          <Skeleton width="70%" height={24} />
          <Skeleton width="40%" height={16} />
        </View>
      </LoadingPage>
    );
  }
  if (query.isError) {
    return isNotFound(query.error) ? (
      <EmptyState icon={IconChecklist} title="This task is gone" />
    ) : (
      <EmptyState icon={IconChecklist} title="This task didn't load">
        <Button intent="plain" label="Try again" onPress={() => void query.refetch()} />
      </EmptyState>
    );
  }
  return <TaskBody task={query.data.task} />;
}

function TaskBody({ task }: { task: CrmTask }) {
  const update = useUpdateTask();
  const names = useMemberNames().data;
  const save = (change: TaskChange) =>
    update.mutate(
      { id: task.id, ...change },
      { onError: (error) => crmErrorAlert(error, "The task was not changed") },
    );
  const nameOf = (memberId: string | null) =>
    memberId ? (names?.get(memberId) ?? "A former member") : null;
  const record = taskRecord(task);
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <TaskActions task={task} onSave={save} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.scroll}
      >
        <View style={styles.head}>
          <View style={styles.titleRow}>
            <View style={styles.check}>
              <CheckCircle
                isSelected={!!task.completedAt}
                label={task.completedAt ? "Reopen" : "Complete"}
                onChange={(done) => save({ done })}
              />
            </View>
            <TitleField task={task} onSave={(title) => save({ title })} />
          </View>
          <BodyField task={task} onSave={(body) => save({ body })} />
        </View>
        <Fields
          fields={[
            [
              "Status",
              task.completedAt ? `Done ${DAY.format(new Date(task.completedAt))}` : "Open",
            ],
            ["Assignee", nameOf(task.assigneeMemberId) ?? "Nobody"],
            ["Due", dueLabel(task.dueAt)],
            ["Created by", nameOf(task.createdByMemberId)],
            ["Created", DAY.format(new Date(task.createdAt))],
          ]}
        />
        {record ? (
          <ItemRow
            icon={RECORD_ICON[record.pathname]}
            title={record.name}
            onPress={() => router.push({ pathname: record.pathname, params: { id: record.id } })}
          />
        ) : null}
      </ScrollView>
    </>
  );
}

function useDraft(saved: string) {
  const [draft, setDraft] = useState(saved);
  const [seen, setSeen] = useState(saved);
  const [editing, setEditing] = useState(false);
  if (saved !== seen && !editing) {
    setSeen(saved);
    setDraft(saved);
  }
  return {
    draft,
    setDraft,
    onFocus: () => setEditing(true),
    done: () => {
      setEditing(false);
      setSeen(saved);
    },
  };
}

function TitleField(props: { task: CrmTask; onSave: (title: string) => void }) {
  const { draft, setDraft, onFocus, done } = useDraft(props.task.title);
  const commit = () => {
    done();
    const title = draft.trim();
    if (!title) return setDraft(props.task.title);
    if (title !== props.task.title) props.onSave(title);
  };
  return (
    <TextField
      label="Title"
      variant="bare"
      multiline
      submitBehavior="blurAndSubmit"
      returnKeyType="done"
      maxLength={TITLE_MAX}
      value={draft}
      onChangeText={setDraft}
      onFocus={onFocus}
      onBlur={commit}
      containerStyle={styles.grow}
      style={styles.title}
    />
  );
}

function BodyField(props: { task: CrmTask; onSave: (body: string | null) => void }) {
  const { draft, setDraft, onFocus, done } = useDraft(props.task.body ?? "");
  return (
    <TextField
      label="Notes"
      variant="bare"
      placeholder="Notes"
      multiline
      maxLength={BODY_MAX}
      value={draft}
      onChangeText={setDraft}
      onFocus={onFocus}
      onBlur={() => {
        done();
        const body = draft.trim() || null;
        if (body !== (props.task.body ?? null)) props.onSave(body);
      }}
      style={styles.body}
    />
  );
}

function TaskActions(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const { task, onSave } = props;
  const names = useMemberNames().data;
  const remove = useDeleteTask();
  const members = names ? [...names] : [];
  const confirmDelete = () =>
    Alert.alert("Delete task?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete task",
        style: "destructive",
        onPress: () =>
          remove.mutate(
            { id: task.id },
            {
              onSuccess: () => router.back(),
              onError: (error) => crmErrorAlert(error, "The task was not deleted"),
            },
          ),
      },
    ]);
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
        <Stack.Toolbar.Menu title="Assignee" icon="person">
          {members.map(([memberId, name]) => (
            <Stack.Toolbar.MenuAction
              key={memberId}
              isOn={memberId === task.assigneeMemberId}
              onPress={() =>
                memberId !== task.assigneeMemberId && onSave({ assigneeMemberId: memberId })
              }
            >
              {name}
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            isOn={!task.assigneeMemberId}
            onPress={() => task.assigneeMemberId && onSave({ assigneeMemberId: null })}
          >
            Nobody
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Menu title="Due" icon="calendar">
          {DUE_CHOICES.map((choice) => (
            <Stack.Toolbar.MenuAction
              key={choice.label}
              icon={choice.icon}
              onPress={() => onSave({ dueAt: dueIn(choice.days) })}
            >
              {choice.label}
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon="calendar.badge.minus"
            onPress={() => task.dueAt && onSave({ dueAt: null })}
          >
            No due date
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
          Delete task
        </Stack.Toolbar.MenuAction>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: space(16), gap: space(6) },
  head: { paddingHorizontal: gutter, paddingTop: space(2), gap: space(2) },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: space(3) },
  check: { height: text.lg.lineHeight + space(2), justifyContent: "center" },
  grow: { flex: 1 },
  title: { ...text.lg, paddingVertical: space(1) },
  body: { ...text.body, minHeight: 160, paddingVertical: space(1), textAlignVertical: "top" },
});
