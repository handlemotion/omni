import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconMaximize, IconTrash, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { useCrmTask } from "@/hooks/use-crm-tasks.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { ApiError } from "@/lib/api.ts";
import type { CrmTask } from "@/lib/crm-tasks.ts";
import { TaskContent, TaskDetails, useDeleteThisTask, useSaveTask } from "./task-page.tsx";

/** The open task in the list's URL (`?task=`): its link, and a way to open or close one. */
export function useOpenTask() {
  const router = useRouter();
  const at = useCallback(
    (task: string | undefined) =>
      router.buildLocation({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, task })) as never,
      }).href,
    [router],
  );
  return useMemo(
    () => ({
      href: (id: string) => at(id),
      close: () => void router.history.push(at(undefined)),
    }),
    [at, router],
  );
}

/** A task beside the list, as an open email sits beside its inbox: its header, then the task. */
export function TaskPanel(props: { id: string; onClose: () => void }) {
  const query = useCrmTask(props.id);
  const task = query.data?.task;
  return (
    <section aria-label="Task" className="flex min-w-0 flex-1 flex-col border-s bg-background">
      {task ? (
        <LoadedTask task={task} onClose={props.onClose} />
      ) : (
        <>
          <PanelHeader title={null} onClose={props.onClose} />
          {query.isPending ? (
            <Skeleton loading label="Loading task" skeleton={<PanelBones />}>
              {null}
            </Skeleton>
          ) : (
            <div className="flex flex-1 flex-col">
              {query.error instanceof ApiError && query.error.status === 404 ? (
                <EmptyState figure="loupe" title="This task is gone" />
              ) : (
                <EmptyState figure="plug" title="This task didn't load">
                  <Button size="sm" intent="outline" onPress={() => void query.refetch()}>
                    Try again
                  </Button>
                </EmptyState>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LoadedTask(props: { task: CrmTask; onClose: () => void }) {
  const { task } = props;
  const save = useSaveTask(task.id);
  const remove = useDeleteThisTask(task.id, props.onClose);
  return (
    <>
      <PanelHeader title={task.title} onClose={props.onClose}>
        <OpenAsPage id={task.id} />
        <Button
          intent="plain"
          size="sq-sm"
          aria-label="Delete task"
          isPending={remove.isPending}
          onPress={remove.run}
        >
          <IconTrash />
        </Button>
      </PanelHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
        <TaskContent task={task} onSave={save} />
        <div className="flex flex-col gap-0.5">
          <TaskDetails task={task} onSave={save} />
        </div>
      </div>
    </>
  );
}

function PanelHeader(props: {
  title: string | null;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2.5">
      <h2 className="min-w-0 flex-1 truncate text-md text-foreground">{props.title}</h2>
      {props.children}
      <Button intent="plain" size="sq-sm" aria-label="Close task" onPress={props.onClose}>
        <IconX />
      </Button>
    </div>
  );
}

function OpenAsPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  return (
    <Button
      intent="plain"
      size="sq-sm"
      aria-label="Open as page"
      onPress={() => void navigate({ to: "/$workspace/crm/tasks/$id", params: { workspace, id } })}
    >
      <IconMaximize />
    </Button>
  );
}

function PanelBones() {
  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <SkeletonBox width="60%" height={12} />
      <SkeletonBox width="85%" height={10} />
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <SkeletonBox width={72} height={10} />
          <SkeletonBox width={`${30 + ((i * 11) % 30)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}
