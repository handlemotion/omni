import { useEffect, type ReactNode } from "react";
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconMaximize,
  IconMinimize,
  IconPencil,
  IconX,
} from "@/components/icons/central";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { PageNav } from "@/components/shell/page-nav";
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
import { useFileEditors } from "@/hooks/use-file-presence.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
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
import { PreviewBody } from "./preview-body.tsx";
import { PreviewRail } from "./preview-rail.tsx";
import { usePreviewTools } from "./preview-tools.tsx";
import { downloadFile } from "@/lib/download.ts";

export function PreviewPanel(props: {
  node: StorageNode;
  url: string;
  /** The files before and after it in the folder, for Previous and Next. */
  previous: StorageNode | undefined;
  next: StorageNode | undefined;
  onOpen: (node: StorageNode) => void;
  onClose: () => void;
  onDownload?: (() => void) | undefined;
  menu: SettingsRowMenuItem[];
  fullScreen: boolean;
  onFullScreen: () => void;
  /** False outside the app shell (a shared link's page): no sidebar toggle. */
  shell: boolean;
  /** The person may change the file: Edit, for a text file. */
  canWrite: boolean;
  /** Opened through a shared link: its door for versions, comments and editing. */
  shareId?: string | undefined;
  /** Rename from its menu turns the title into a field. */
  rename?: InlineRename | undefined;
}) {
  const { node } = props;
  const tools = usePreviewTools(node, props.shareId);
  const shown = tools.shown;
  const download = shown && props.onDownload ? () => downloadFile(shown.url) : props.onDownload;
  const session = useEditSession(node, props.url, props.shareId);
  const canEdit = props.canWrite && canEditFile(node) && !shown;
  const doc = canEdit && isDoc(node);
  useAlwaysEditing(session, doc);
  return (
    <section aria-label={node.name} className="flex min-w-0 flex-1 flex-col bg-background">
      <div
        className={`flex h-12 shrink-0 items-center gap-3 border-b pe-2.5 ${props.fullScreen ? "ps-2.5" : "border-s ps-5"}`}
      >
        {props.fullScreen && props.shell && <PageNav />}
        <Title node={node} rename={props.rename} />
        <div className="flex shrink-0 items-center gap-1">
          {props.shell && <FileEditors nodeId={node.id} />}
          <EditActions session={session} canEdit={canEdit} doc={doc} />
          <Action
            label="Previous"
            isDisabled={!props.previous}
            onPress={() => props.previous && props.onOpen(props.previous)}
          >
            <IconChevronLeft />
          </Action>
          <Action
            label="Next"
            isDisabled={!props.next}
            onPress={() => props.next && props.onOpen(props.next)}
          >
            <IconChevronRight />
          </Action>
          {download && (
            <Action label="Download" onPress={download}>
              <IconDownload />
            </Action>
          )}
          {!session.dirty && (
            <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} />
          )}
          <Action
            label={props.fullScreen ? "Side by side" : "Full screen"}
            onPress={props.onFullScreen}
          >
            {props.fullScreen ? <IconMinimize /> : <IconMaximize />}
          </Action>
          <Action label="Close" onPress={props.onClose}>
            <IconX />
          </Action>
        </div>
      </div>
      <div
        className={`flex min-h-0 flex-1 flex-col bg-surface ${props.fullScreen ? "" : "border-s"}`}
      >
        {session.editing ? (
          <DocumentEditor session={session} onDownload={props.onDownload} />
        ) : (
          <Stage node={node} url={props.url} tools={tools} onDownload={download} />
        )}
      </div>
      <Details node={shown?.node ?? node} border={!props.fullScreen} />
    </section>
  );
}

function Details(props: { node: StorageNode; border: boolean }) {
  const { node } = props;
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

function useAlwaysEditing(session: EditSession, doc: boolean) {
  const { editing, start, editor } = session;
  useEffect(() => {
    if (doc && !editing) start();
  }, [doc, editing, start, editor.node.id]);
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
