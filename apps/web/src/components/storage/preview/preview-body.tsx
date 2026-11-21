import { lazy, Suspense } from "react";
import { Contain } from "@/components/errors/error-boundary.tsx";
import { fileType, IMAGE_PREVIEW_MAX_BYTES, SHEET_PREVIEW_MAX_BYTES } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { previewThumbnail } from "../thumbnail-image.tsx";
import { ImagePreview } from "./image-preview.tsx";
import { AudioPreview, VideoPreview } from "./media-preview.tsx";
import { PREVIEW_CODE } from "./preview-code.ts";
import { NoPreview, StageLoading } from "./shared.tsx";

const PdfPreview = lazy(PREVIEW_CODE.pdf);
const CodePreview = lazy(PREVIEW_CODE.text);
const CsvPreview = lazy(PREVIEW_CODE.csv);
const XlsxPreview = lazy(PREVIEW_CODE.sheet);

export function PreviewBody(props: {
  node: StorageNode;
  url: string;
  onDownload?: (() => void) | undefined;
}) {
  const { node, url, onDownload } = props;
  const type = fileType(node.name, node.mimeType);
  const source = { url, version: node.updatedAt, size: node.size };
  const none = <NoPreview kind={type.kind} onDownload={onDownload} />;
  if (node.size === 0) return none;
  switch (type.preview) {
    case "image":
      return type.raster && node.size <= IMAGE_PREVIEW_MAX_BYTES ? (
        <ImagePreview
          key={node.id}
          source={source}
          raster={type.raster}
          name={node.name}
          placeholder={previewThumbnail(node, url)}
          onDownload={onDownload}
        />
      ) : (
        none
      );
    case "video":
      return <VideoPreview key={node.id} url={url} name={node.name} onDownload={onDownload} />;
    case "audio":
      return (
        <AudioPreview
          key={node.id}
          url={url}
          name={node.name}
          kind={type.kind}
          onDownload={onDownload}
        />
      );
    case "pdf":
      return (
        <Contain fallback={none}>
          <Suspense fallback={<StageLoading label="Loading PDF" />}>
            <PdfPreview key={node.id} url={url} onDownload={onDownload} />
          </Suspense>
        </Contain>
      );
    case "text":
      return (
        <Contain fallback={none}>
          <Suspense fallback={<StageLoading label="Loading file" />}>
            <CodePreview
              key={node.id}
              source={source}
              kind={type.kind}
              language={type.language}
              onDownload={onDownload}
            />
          </Suspense>
        </Contain>
      );
    case "csv":
      return (
        <Contain fallback={none}>
          <Suspense fallback={<StageLoading label="Loading table" />}>
            <CsvPreview key={node.id} source={source} onDownload={onDownload} />
          </Suspense>
        </Contain>
      );
    case "sheet":
      return node.size <= SHEET_PREVIEW_MAX_BYTES ? (
        <Contain fallback={none}>
          <Suspense fallback={<StageLoading label="Loading spreadsheet" />}>
            <XlsxPreview key={node.id} source={source} onDownload={onDownload} />
          </Suspense>
        </Contain>
      ) : (
        none
      );
    default:
      return none;
  }
}
