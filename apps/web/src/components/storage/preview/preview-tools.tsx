// The island's state for the open file: the comment tool, the box drawn with it and its bar, the
// threads pinned on the file, and the version on the stage. On a PDF or an image, Comment is a
// targeting mode (Cursor turns it off): a drag draws a box and opens the bar beside it; on any
// other file Comment opens the bar for the whole file over the island. Stepping to another file
// starts it over.
import { useState } from "react";
import { useRestoreVersion, useStorageComments, useStorageVersions } from "@/hooks/use-storage.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import type { StorageComment, StorageCommentAnchor } from "@/lib/storage-comments.ts";
import { storageVersionUrl, type StorageVersions } from "@/lib/storage-versions.ts";
import { storageErrorToast } from "../storage-errors.ts";
import { CommentComposer } from "./comment-composer.tsx";
import type { PdfBox, PdfMarks, PdfPin } from "./pdf-marks.tsx";
import type { PreviewRail, RailVersion } from "./preview-rail.tsx";

/** The version on the stage when it is not the current content. */
interface ShownVersion {
  key: string;
  url: string;
  /** The file as that version had it: its size, type and when it was written. */
  node: StorageNode;
}

/** What a box is drawn on: a PDF's pages, or an image (its one "page"). */
type Surface = "pdf" | "image";

/** "v3" down to "v1": the current content leads, numbered from the oldest kept version. */
function railVersions(data: StorageVersions): RailVersion[] {
  const count = data.versions.length + 1;
  return [
    { key: "current", label: `v${count}`, ...data.current },
    ...data.versions.map((version, index) => ({
      key: version.id,
      label: `v${count - 1 - index}`,
      writtenAt: version.writtenAt,
      writtenByName: version.writtenByName,
    })),
  ];
}

/** The anchor a box drawn on `surface` is sent as. */
function anchorOf(surface: Surface, box: PdfBox): StorageCommentAnchor {
  const { page, ...rest } = box;
  return surface === "pdf" ? { kind: "pdf", page, ...rest } : { kind: "image", ...rest };
}

/** A thread's box on `surface`, if it has one there; an image's is on its one page. */
function boxOf(surface: Surface, anchor: StorageCommentAnchor | null): PdfBox | null {
  if (anchor?.kind === "pdf" && surface === "pdf") return anchor;
  if (anchor?.kind === "image" && surface === "image") return { page: 1, ...anchor };
  return null;
}

/** Open threads made on the content on the stage; a box on replaced content points nowhere. */
function pinsOf(
  surface: Surface,
  data: { contentVersion: number; comments: StorageComment[] },
): PdfPin[] {
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
  });
}

function surfaceOf(node: StorageNode): Surface | null {
  const preview = fileType(node.name, node.mimeType).preview;
  return preview === "pdf" || preview === "image" ? preview : null;
}

export function usePreviewTools(node: StorageNode, shareId: string | undefined) {
  const [fileId, setFileId] = useState(node.id);
  const [shownKey, setShownKey] = useState("current");
  const [composing, setComposing] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const [draft, setDraft] = useState<PdfBox | null>(null);
  // The content the box was drawn on, so a replacement before Send can't take the comment.
  const [draftVersion, setDraftVersion] = useState<number | undefined>(undefined);
  if (fileId !== node.id) {
    setFileId(node.id);
    setShownKey("current");
    setComposing(false);
    setTargeting(false);
    setDraft(null);
  }

  // Each answers 403 to whoever may not: a Viewer gets neither, a Commenter no versions.
  const versions = useStorageVersions(node.id, shareId);
  const comments = useStorageComments(node.id, shareId);
  const restore = useRestoreVersion();
  const surface = surfaceOf(node);

  const list = versions.data ? railVersions(versions.data) : undefined;
  const kept = versions.data?.versions.find((version) => version.id === shownKey);
  const shown: ShownVersion | undefined = kept && {
    key: kept.id,
    url: storageVersionUrl(node.id, kept.id, shareId),
    node: {
      ...node,
      size: kept.size,
      mimeType: kept.mimeType ?? node.mimeType,
      updatedAt: kept.writtenAt,
    },
  };

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
  // A comment belongs to the current content: none while an older version is on the stage.
  const marks: PdfMarks | null =
    surface && !shown && data
      ? {
          pins: pinsOf(surface, data),
          draft: draft && { box: draft, composer },
          selected: null,
          drawing: targeting,
          // Comment stays on until Cursor: each drag moves the bar to its box.
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
              // Cursor is for reading: a box's comment not sent goes with it.
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
