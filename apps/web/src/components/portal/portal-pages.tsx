import { useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { DetailSection, NoneRow } from "@/components/crm/record-layout.tsx";
import { EmptyState } from "@/components/empty/empty-state";
import { ListFailed } from "@/components/inbox/thread-list";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { FileGlyph } from "@/components/storage/file-glyph";
import { LinkFrame } from "@/components/storage/link-frame";
import { Badge } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api.ts";
import { DELIVERABLE_STATUSES, MILESTONE_STATUSES } from "@/lib/crm-project.ts";
import { dueLabel } from "@/lib/crm-tasks.ts";
import { fileType } from "@/lib/file-kind.ts";
import { usePortalProject, usePortalProjects, useReviewDeliverable } from "@/hooks/use-portal.ts";
import { type PortalDeliverable, type PortalDetail, type PortalFile } from "@/lib/portal.ts";

const dayLabel = (day: string | null) => (day ? dueLabel(`${day}T12:00:00`) : null);
const label = (list: { id: string; label: string }[], id: string) =>
  list.find((one) => one.id === id)?.label ?? id;

const DELIVERABLE_INTENT = {
  draft: "secondary",
  in_review: "info",
  approved: "success",
  changes_requested: "warning",
} as const;
const MILESTONE_INTENT = { planned: "secondary", in_progress: "info", done: "success" } as const;
const CONTRACT_INTENT = { sent: "info", signed: "success", ended: "secondary" } as const;
const CONTRACT_LABEL = { sent: "Sent", signed: "Signed", ended: "Ended" } as const;

function PortalBody(props: { children: React.ReactNode }) {
  return (
    <LinkFrame>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
          {props.children}
        </div>
      </div>
    </LinkFrame>
  );
}

function Rows() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 px-2">
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${30 + ((i * 17) % 40)}%`} height={10} />
          </span>
          <SkeletonBox width={48} height={10} />
        </div>
      ))}
    </div>
  );
}

/** Every project the signed-in person is a client on, in any studio. */
export function PortalHome() {
  const projects = usePortalProjects();
  return (
    <PortalBody>
      <h1 className="text-lg text-foreground">Projects</h1>
      {projects.isPending ? (
        <Skeleton loading label="Loading projects" skeleton={<Rows />}>
          {null}
        </Skeleton>
      ) : projects.isError ? (
        <ListFailed retry={() => void projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <EmptyState figure="cabinet" title="No projects" />
      ) : (
        <ul className="flex flex-col">
          {projects.data.map((project) => (
            <li key={project.id}>
              <Link
                href={`/portal/${encodeURIComponent(project.id)}`}
                className="flex h-10 min-w-0 items-center gap-3 rounded-lg px-2 text-sm text-foreground transition-colors duration-150 ease-out hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="shrink-0 truncate text-xs text-muted-foreground">
                  {project.workspaceName}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PortalBody>
  );
}

/** One project as its client sees it: the plan, what waits on them, contracts and files. */
export function PortalProjectPage(props: { id: string }) {
  const project = usePortalProject(props.id);
  if (project.isPending) {
    return (
      <PortalBody>
        <Skeleton loading label="Loading the project" skeleton={<Rows />}>
          {null}
        </Skeleton>
      </PortalBody>
    );
  }
  if (project.isError) {
    const gone = project.error instanceof ApiError && project.error.status === 404;
    return (
      <PortalBody>
        {gone ? (
          <EmptyState figure="loupe" title="Not found" />
        ) : (
          <ListFailed retry={() => void project.refetch()} />
        )}
      </PortalBody>
    );
  }
  return <ProjectDetail detail={project.data} />;
}

function ProjectDetail({ detail }: { detail: PortalDetail }) {
  return (
    <PortalBody>
      <header className="flex flex-col gap-1">
        <h1 className="text-lg text-foreground">{detail.project.name}</h1>
        <span className="text-sm text-muted-foreground">{detail.project.workspaceName}</span>
      </header>
      <DetailSection title="Milestones">
        {detail.milestones.length ? (
          detail.milestones.map((milestone) => (
            <div key={milestone.id} className="flex h-8 min-w-0 items-center gap-2 text-sm">
              <span className="truncate text-foreground">{milestone.title}</span>
              <Badge intent={MILESTONE_INTENT[milestone.status]} className="shrink-0">
                {label(MILESTONE_STATUSES, milestone.status)}
              </Badge>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {dayLabel(milestone.targetOn)}
              </span>
            </div>
          ))
        ) : (
          <NoneRow />
        )}
      </DetailSection>
      <DetailSection title="Deliverables">
        {detail.deliverables.length ? (
          detail.deliverables.map((deliverable) => (
            <DeliverableRow
              key={deliverable.id}
              projectId={detail.project.id}
              deliverable={deliverable}
            />
          ))
        ) : (
          <NoneRow />
        )}
      </DetailSection>
      <DetailSection title="Contracts">
        {detail.contracts.length ? (
          detail.contracts.map((contract) => (
            <div key={contract.id} className="flex h-8 min-w-0 items-center gap-2 text-sm">
              <span className="truncate text-foreground">{contract.title}</span>
              <Badge intent={CONTRACT_INTENT[contract.status]} className="shrink-0">
                {CONTRACT_LABEL[contract.status]}
              </Badge>
              {contract.signingRequestId && (
                <Link
                  href={`/sign/${encodeURIComponent(contract.signingRequestId)}`}
                  className={buttonStyles({
                    intent: "secondary",
                    size: "sm",
                    className: "ms-auto",
                  })}
                >
                  {contract.status === "sent" ? "Sign" : "Open"}
                </Link>
              )}
            </div>
          ))
        ) : (
          <NoneRow />
        )}
      </DetailSection>
      <DetailSection title="Files">
        {detail.folder?.files.length ? (
          detail.folder.files.map((file) => <FileRow key={file.id} file={file} />)
        ) : (
          <NoneRow />
        )}
      </DetailSection>
    </PortalBody>
  );
}

const fileHref = (file: PortalFile) =>
  file.shareId
    ? `/s/${encodeURIComponent(file.shareId)}?node=${encodeURIComponent(file.id)}`
    : null;

function FileRow(props: { file: PortalFile }) {
  const { file } = props;
  const href = fileHref(file);
  const glyph = (
    <FileGlyph
      kind={file.kind === "folder" ? "folder" : fileType(file.name, file.mimeType).kind}
      className="size-4 shrink-0"
    />
  );
  const name = <span className="min-w-0 truncate">{file.name}</span>;
  return href ? (
    <Link
      href={href}
      className="-mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors duration-150 ease-out hover:bg-hover"
    >
      {glyph}
      {name}
    </Link>
  ) : (
    <span className="flex h-8 min-w-0 items-center gap-2 text-sm text-foreground">
      {glyph}
      {name}
    </span>
  );
}

function DeliverableRow(props: { projectId: string; deliverable: PortalDeliverable }) {
  const { deliverable } = props;
  const review = useReviewDeliverable();
  const [asking, setAsking] = useState(false);
  const decide = (decision: "approve" | "request_changes", note?: string, then?: () => void) =>
    review.mutate(
      { projectId: props.projectId, deliverableId: deliverable.id, decision, note },
      {
        onSuccess: then,
        onError: () => appToast.error("Your answer was not saved"),
      },
    );
  const file = deliverable.file;
  const href = file ? fileHref(file) : null;
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex min-h-8 min-w-0 items-center gap-2 text-sm">
        {href ? (
          <Link href={href} className="truncate text-foreground hover:underline">
            {deliverable.title}
          </Link>
        ) : (
          <span className="truncate text-foreground">{deliverable.title}</span>
        )}
        <Badge intent={DELIVERABLE_INTENT[deliverable.status]} className="shrink-0">
          {label(DELIVERABLE_STATUSES, deliverable.status)}
        </Badge>
        <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {dayLabel(deliverable.dueOn)}
        </span>
        {deliverable.status === "in_review" && (
          <span className="flex shrink-0 gap-2">
            <Button size="sm" intent="secondary" onPress={() => setAsking(true)}>
              Request changes
            </Button>
            <Button
              size="sm"
              isPending={review.isPending && review.variables.decision === "approve"}
              onPress={() => decide("approve")}
            >
              Approve
            </Button>
          </span>
        )}
      </div>
      {deliverable.status === "changes_requested" && deliverable.reviewNote && (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">
          {deliverable.reviewNote}
        </p>
      )}
      {asking && (
        <ChangesDialog
          title={deliverable.title}
          saving={review.isPending}
          onSubmit={(note) => decide("request_changes", note, () => setAsking(false))}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

function ChangesDialog(props: {
  title: string;
  saving: boolean;
  onSubmit: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Request changes"
      action="Send"
      disabled={!note.trim()}
      saving={props.saving}
      onSubmit={() => props.onSubmit(note.trim())}
    >
      <Textarea
        aria-label="What should change"
        autoFocus
        rows={5}
        maxLength={5000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    </SettingsFormDialog>
  );
}
