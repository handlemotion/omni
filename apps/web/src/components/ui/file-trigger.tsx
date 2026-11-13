import { useRef, type ReactNode } from "react";

export interface FileTriggerProps {
  allowsMultiple?: boolean;
  /** MIME types or extensions, as the input's `accept`. */
  acceptedFileTypes?: string[];
  acceptDirectory?: boolean;
  /** Opens the camera on phones: "user" (front) or "environment" (back). */
  defaultCamera?: "user" | "environment";
  onSelect?: (files: FileList | null) => void;
  /** The control that opens the picker: a button. Without one, open it through `ref`. */
  children?: ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}

/**
 * Opens the file picker from whatever button it wraps. A press on that button (click, Enter or
 * Space all fire `click`) bubbles here and clicks a hidden file input, so the button keeps its
 * own name and role and the input never takes focus.
 */
export function FileTrigger({
  allowsMultiple,
  acceptedFileTypes,
  acceptDirectory,
  defaultCamera,
  onSelect,
  children,
  ref,
}: FileTriggerProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span
      className="contents"
      onClick={(event) => {
        if (event.target !== input.current) input.current?.click();
      }}
    >
      {children}
      <input
        ref={(node) => {
          input.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="file"
        hidden
        tabIndex={-1}
        multiple={allowsMultiple}
        accept={acceptedFileTypes?.join(",")}
        capture={defaultCamera}
        {...(acceptDirectory ? { webkitdirectory: "" } : {})}
        onChange={(event) => {
          onSelect?.(event.target.files);
          // Picking the same file again still fires `change`.
          event.target.value = "";
        }}
      />
    </span>
  );
}
