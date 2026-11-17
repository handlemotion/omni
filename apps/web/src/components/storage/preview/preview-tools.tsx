import { useState } from "react";
import { useRestoreVersion, useStorageComments, useStorageVersions } from "@/hooks/use-storage.ts";
import { fileType, IMAGE_PREVIEW_MAX_BYTES } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import type { StorageComment, StorageCommentAnchor } from "@/lib/storage-comments.ts";
import { storageVersionUrl, type StorageVersions } from "@/lib/storage-versions.ts";
import { storageErrorToast } from "../storage-errors.ts";
import { CommentComposer } from "./comment-composer.tsx";
import type { PdfBox, PdfMarks, PdfPin } from "./pdf-marks.tsx";
import type { PreviewRail, RailVersion } from "./preview-rail.tsx";

interface ShownVersion {
  key: string;
  url: string;
  node: StorageNode;
}

type Surface = "pdf" | "image";

function railVersions(data: StorageVersions) {
  const count = data.versions.length + 1;
  return [
    { key: "current", label: `v${count}`, ...data.current },
    ...data.versions.map((version, index) => ({
      key: version.id,
      label: `v${count - 1 - index}`,
      writtenAt: version.writtenAt,
      writtenByName: version.writtenByName,
    })),
  ] satisfies RailVersion[];
}

const anchorOf: (surface: Surface, box: PdfBox) => StorageCommentAnchor = (surface, box) => {
  const { page, ...rest } = box;
  return surface === "pdf" ? { kind: "pdf", page, ...rest } : { kind: "image", ...rest };
};

const boxOf: (surface: Surface, anchor: StorageCommentAnchor | null) => PdfBox | null = (
  surface,
  anchor,
) => {
  if (anchor?.kind === "pdf" && surface === "pdf") return anchor;
  if (anchor?.kind === "image" && surface === "image") return { page: 1, ...anchor };
  return null;
};

function pinsOf(surface: Surface, data: { contentVersion: number; comments: StorageComment[] }) {
  return data.comments.flatMap((comment) => {
    const box = boxOf(surface, comment.anchor);
    if (!box || comment.parentId !== null || comment.resolvedAt) return [];
    if (comment.contentVersion !== data.contentVersion) return [];
    return [
      {
        ...box,
        id: comment.id,
        authorName: comment.authorName ?? "Someone",
        authorImage: comment.authorImage ?? null,
        body: comment.body,
      },
    ];
  }) satisfies PdfPin[];
}

const surfaceOf: (node: StorageNode) => Surface | null = (node) => {
  const type = fileType(node.name, node.mimeType);
  if (node.size === 0) return null;
  if (type.preview === "pdf") return "pdf";
  if (type.preview === "image" && type.raster && node.size <= IMAGE_PREVIEW_MAX_BYTES) {
    return "image";
  }
  return null;
};

function shownOf(
  node: StorageNode,
  kept: StorageVersions["versions"][number],
  shareId: string | undefined,
) {
  return {
    key: kept.id,
    url: storageVersionUrl(node.id, kept.id, shareId),
    node: {
      ...node,
      size: kept.size,
      mimeType: kept.mimeType ?? node.mimeType,
      updatedAt: kept.writtenAt,
    },
  } satisfies ShownVersion;
}

export function usePreviewTools(node: StorageNode, shareId: string | undefined) {
  const [fileId, setFileId] = useState(node.id);
  const [shownKey, setShownKey] = useState("current");
  const [composing, setComposing] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const [draft, setDraft] = useState<PdfBox | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | undefined>(undefined);
  const [unshownAt, setUnshownAt] = useState<number | null>(null);
  if (fileId !== node.id) {
    setFileId(node.id);
    setShownKey("current");
    setComposing(false);
    setTargeting(false);
    setUnshownAt(null);
    setDraft(null);
  }

  const versions = useStorageVersions(node.id, shareId);
  const comments = useStorageComments(node.id, shareId);
  const restore = useRestoreVersion();
  const surface = unshownAt === comments.data?.contentVersion ? null : surfaceOf(node);

  const list = versions.data ? railVersions(versions.data) : undefined;
  const kept = versions.data?.versions.find((version) => version.id === shownKey);
  const shown = kept && shownOf(node, kept, shareId);

  const close = () => {
    setComposing(false);
    setDraft(null);
  };
  const composer = (
    <CommentComposer
      fileId={node.id}
      shareId={shareId}
      anchor={draft && surface ? anchorOf(surface, draft) : null}
      contentVersion={draftVersion}
      onClose={close}
      onSent={close}
    />
  );

  const data = comments.data;
  const marks: PdfMarks | null =
    surface && !shown && data
      ? {
          pins: pinsOf(surface, data),
          draft: draft && { box: draft, composer },
          selected: null,
          drawing: targeting,
          onUnshown: () => {
            setUnshownAt(data.contentVersion);
            setTargeting(false);
            setDraft(null);
          },
          onDraw: (box) => {
            setDraft(box);
            setDraftVersion(data.contentVersion);
          },
        }
      : null;

  const rail: Parameters<typeof PreviewRail>[0] = {
    target:
      data && surface
        ? {
            on: targeting,
            isDisabled: !!shown,
            onChange: (on: boolean) => {
              setTargeting(on);
              if (!on) setDraft(null);
            },
          }
        : undefined,
    comment:
      data && !surface
        ? {
            open: composing,
            isDisabled: !!shown,
            onToggle: () => setComposing(!composing),
            composer,
          }
        : undefined,
    versions: list && {
      list,
      shown: shown ? shown.key : "current",
      onShow: setShownKey,
      restoring: restore.isPending,
      onRestore: () =>
        kept &&
        restore.mutate(
          { id: node.id, versionId: kept.id, ...(shareId ? { shareId } : {}) },
          {
            onSuccess: () => setShownKey("current"),
            onError: (error) => storageErrorToast(error, "It was not restored"),
          },
        ),
    },
  };

  return { shown, marks, rail, contentVersion: data?.contentVersion };
}
