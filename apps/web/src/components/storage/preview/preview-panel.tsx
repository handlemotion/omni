import { useEffect, type ReactNode } from "react";
import {
  IconCheck,
  IconMaximize,
  IconMinimize,
  IconPencil,
  IconX,
} from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { PageNav, usePageNavShown } from "@/components/shell/page-nav";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Avatar } from "@/components/ui/avatar";
import { Heading } from "@/components/ui/heading";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import type { InlineRename } from "@/hooks/use-inline-rename.ts";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DocCommentsContext,
  useDocCommentsState,
  type DocComments,
} from "@/hooks/use-doc-comments.ts";
import { useFileEditors } from "@/hooks/use-file-presence.ts";
import { useShowDetails } from "@/hooks/use-show-details.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { CommentsPanel } from "../comments-panel.tsx";
import { TypeBadge } from "../file-glyph.tsx";
import { DAY } from "../file-table.tsx";
import { FIELD_OFFSET, NameField } from "../name-field.tsx";
import { PdfMarksContext } from "./pdf-marks.tsx";
import {
  canEditFile,
  DocumentEditor,
  isDoc,
  useEditSession,
  type EditSession,
} from "../editor/document-editor.tsx";
import { DocBar } from "../editor/doc-bar.tsx";
import { HeaderMenu } from "./header-menu.tsx";
import { PreviewBody } from "./preview-body.tsx";
import { PreviewRail } from "./preview-rail.tsx";
import { usePreviewTools } from "./preview-tools.tsx";
import { downloadFile } from "@/lib/download.ts";

export function PreviewPanel(props: {
  node: StorageNode;
  url: string;
  /** Absent on a shared link's own page, where the file is the whole page: no Close. */
  onClose?: (() => void) | undefined;
  onDownload?: (() => void) | undefined;
  menu: SettingsRowMenuItem[];
  fullScreen: boolean;
  onFullScreen?: (() => void) | undefined;
  /** False outside the app shell (a shared link's page): no sidebar toggle. */
  shell: boolean;
  /** The person may change the file: Edit, for a text file. */
  canWrite: boolean;
  /** Opened through a shared link: its door for versions, comments and editing. */
  shareId?: string | undefined;
  /** Rename from its menu turns the title into a field. */
  rename?: InlineRename | undefined;
  /** False for a shared link's viewer: a doc reads as a page, with no comments. */
  canComment?: boolean;
  /** False on a shared link that forbids downloads: a doc has no Export. */
  canExport?: boolean;
}) {
  const { node } = props;
  const tools = usePreviewTools(node, props.shareId, {
    versions: !props.shareId || props.canWrite,
    comments: props.canComment !== false,
  });
  const shown = tools.shown;
  const download = shown && props.onDownload ? () => downloadFile(shown.url) : props.onDownload;
  const session = useEditSession(node, props.url, props.shareId, props.canWrite);
  const canEdit = props.canWrite && canEditFile(node) && !shown;
  const doc = canEditFile(node) && !shown && isDoc(node);
  const inset = useHeaderInset(props.fullScreen, props.shell);
  useAlwaysEditing(session, doc);
  const comments = useDocCommentsState(
    node.id,
    props.shareId,
    doc && session.editing && props.canComment !== false,
  );
  const [details, toggleDetails] = useShowDetails();
  const exports = doc && !shown ? session.text : undefined;
  return (
    <section aria-label={node.name} className="flex min-w-0 flex-1 flex-col bg-background">
      <div className={`flex h-12 shrink-0 items-center gap-3 border-b pe-2.5 ${inset}`}>
        {props.fullScreen && props.shell && <PageNav />}
        <Title node={node} rename={props.rename} />
        <div className="flex shrink-0 items-center gap-1">
          {props.shell && <FileEditors nodeId={node.id} />}
          <EditActions session={session} canEdit={canEdit} doc={doc} />
          <HeaderMenu
            dirty={session.dirty}
            node={node}
            items={versionAware(props.menu, download)}
            exports={exports}
            details={details}
            onDetails={toggleDetails}
          />
          <WindowActions
            fullScreen={props.fullScreen}
            onFullScreen={props.onFullScreen}
            onClose={props.onClose}
          />
        </div>
      </div>
      <DocBar
        node={node}
        items={props.menu}
        session={session}
        text={exports}
        border={!props.fullScreen}
        canExport={props.canExport}
      />
      <div
        className={`flex min-h-0 flex-1 flex-col bg-surface ${props.fullScreen ? "" : "border-s"}`}
      >
        {session.editing ? (
          <EditingBody
            session={session}
            comments={comments.on ? comments : null}
            shareId={props.shareId}
            onDownload={props.onDownload}
          />
        ) : (
          <Stage node={node} url={props.url} tools={tools} onDownload={download} />
        )}
      </div>
      <Details node={shown?.node ?? node} border={!props.fullScreen} shown={details} />
    </section>
  );
}

function EditingBody(props: {
  session: EditSession;
  comments: DocComments | null;
  shareId: string | undefined;
  onDownload?: (() => void) | undefined;
}) {
  const { session, comments } = props;
  return (
    <DocCommentsContext value={comments}>
      <div className="flex min-h-0 flex-1">
        <DocumentEditor session={session} onDownload={props.onDownload} />
        {comments?.open && (
          <div className="flex w-80 min-w-0 shrink-0">
            <CommentsPanel
              node={session.editor.node}
              shareId={props.shareId}
              onClose={comments.close}
              doc={comments}
            />
          </div>
        )}
      </div>
    </DocCommentsContext>
  );
}

function Details(props: { node: StorageNode; border: boolean; shown: boolean }) {
  const { node } = props;
  if (!props.shown) return null;
  const rows: [string, ReactNode][] = [
    ["Kind", <TypeBadge key="kind" label={fileType(node.name, node.mimeType).label} />],
    ["Size", formatBytes(node.size)],
    ["Modified", DAY.format(new Date(node.updatedAt))],
    ["Created", DAY.format(new Date(node.createdAt))],
  ];
  return (
    <DescriptionList
      className={`flex h-10 shrink-0 items-center justify-between gap-x-5 overflow-hidden border-t px-5 text-sm sm:text-sm ${props.border ? "border-s" : ""}`}
    >
      {rows.map(([term, value]) => (
        <div key={term} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          <DescriptionTerm className="border-none p-0 sm:p-0">{term}</DescriptionTerm>
          <DescriptionDetails className="border-none p-0 tabular-nums sm:border-none sm:p-0">
            {value}
          </DescriptionDetails>
        </div>
      ))}
    </DescriptionList>
  );
}

function FileEditors(props: { nodeId: string }) {
  const me = useMember().member.id;
  const editors = useFileEditors(props.nodeId).filter((editor) => editor.memberId !== me);
  const members = useMembers().data?.members ?? [];
  if (editors.length === 0) return null;
  return (
    <div className="me-1 flex items-center -space-x-1">
      {editors.map((editor) => {
        const member = members.find((m) => m.id === editor.memberId);
        const name = member?.user.name || member?.user.email || "Someone";
        return (
          <TooltipTrigger key={editor.memberId} delay={400}>
            <Button intent="plain" size="sq-sm" aria-label={`${name} is editing`}>
              <Avatar
                size="xs"
                src={member?.user.image ?? null}
                initials={name.slice(0, 1).toUpperCase()}
                className="bg-accent text-foreground outline-2 outline-background"
              />
            </Button>
            <Tooltip>{name} is editing</Tooltip>
          </TooltipTrigger>
        );
      })}
    </div>
  );
}

function EditActions(props: { session: EditSession; canEdit: boolean; doc: boolean }) {
  const { session } = props;
  if (!session.editing) {
    return (
      props.canEdit && (
        <Action label="Edit" onPress={session.start}>
          <IconPencil />
        </Action>
      )
    );
  }
  if (props.doc) return null;
  return (
    <>
      <Button
        intent="outline"
        size="sm"
        isDisabled={!session.dirty}
        isPending={session.saving}
        onPress={() => void session.save()}
      >
        Save
      </Button>
      {!props.doc && (
        <Action label="Done" isDisabled={session.saving} onPress={() => void session.done()}>
          <IconCheck />
        </Action>
      )}
    </>
  );
}

function useHeaderInset(fullScreen: boolean, shell: boolean) {
  const nav = usePageNavShown() && shell;
  if (!fullScreen) return "border-s ps-5";
  return nav ? "ps-2.5" : "ps-5";
}

function useAlwaysEditing(session: EditSession, doc: boolean) {
  const { editing, start, editor } = session;
  useEffect(() => {
    if (doc && !editing) start();
  }, [doc, editing, start, editor.node.id]);
}

function WindowActions(props: {
  fullScreen: boolean;
  onFullScreen: (() => void) | undefined;
  onClose: (() => void) | undefined;
}) {
  return (
    <>
      {props.onFullScreen && (
        <Action
          label={props.fullScreen ? "Side by side" : "Full screen"}
          onPress={props.onFullScreen}
        >
          {props.fullScreen ? <IconMinimize /> : <IconMaximize />}
        </Action>
      )}
      {props.onClose && (
        <Action label="Close" onPress={props.onClose}>
          <IconX />
        </Action>
      )}
    </>
  );
}

function versionAware(items: SettingsRowMenuItem[], download: (() => void) | undefined) {
  if (!download) return items;
  return items.map((item) => (item.label === "Download" ? { ...item, onAction: download } : item));
}

function Action(props: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label={props.label}
        isDisabled={props.isDisabled}
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

function Stage(props: {
  node: StorageNode;
  url: string;
  tools: ReturnType<typeof usePreviewTools>;
  onDownload?: (() => void) | undefined;
}) {
  const { shown, marks, rail, contentVersion } = props.tools;
  return (
    <>
      <PdfMarksContext value={marks}>
        <PreviewBody
          key={shown?.key ?? `current:${contentVersion ?? ""}`}
          node={shown?.node ?? props.node}
          url={shown?.url ?? props.url}
          onDownload={props.onDownload}
        />
      </PdfMarksContext>
      <PreviewRail {...rail} />
    </>
  );
}

function Title(props: { node: StorageNode; rename?: InlineRename | undefined }) {
  const { node, rename } = props;
  const renaming = rename?.renaming?.id === node.id && rename.renaming.at === "preview";
  if (renaming && rename.renaming?.step === "naming") {
    return (
      <NameField
        name={node.name}
        label="Name"
        select="stem"
        className={FIELD_OFFSET.row}
        onFinish={(value, by) => rename.finish(node, value, by)}
      />
    );
  }
  const name = renaming && rename.renaming ? rename.renaming.name : node.name;
  return (
    <Heading level={2} className="min-w-0 flex-1 text-md" title={name}>
      <MiddleTruncate text={name} />
    </Heading>
  );
}
