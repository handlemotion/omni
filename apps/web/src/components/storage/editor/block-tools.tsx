import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { cn } from "cn";
import { useRef } from "react";
import {
  IconBold,
  IconCode,
  IconCommentPlain,
  IconGrip,
  IconItalic,
  IconPlus,
  IconStrike,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { popupSurface } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { openSlashMenu } from "./slash-menu.tsx";

/**
 * Beside the block under the pointer: add a block after it (with the `/` menu open on it), and a
 * grip to drag it somewhere else.
 */
export function BlockHandle(props: { editor: Editor }) {
  const { editor } = props;
  const hovered = useRef<{ pos: number; size: number } | null>(null);
  const add = () => {
    const at = hovered.current;
    if (!at) return;
    const after = at.pos + at.size;
    editor.chain().insertContentAt(after, { type: "paragraph" }).run();
    openSlashMenu(editor, { from: after + 1, to: after + 1 });
  };
  return (
    <DragHandle
      editor={editor}
      onNodeChange={({ node, pos }) => {
        hovered.current = node ? { pos, size: node.nodeSize } : null;
      }}
    >
      <div className="document-handle flex items-center">
        <TooltipTrigger delay={400}>
          <Button intent="plain" size="sq-xs" aria-label="Add a block below" onPress={add}>
            <IconPlus />
          </Button>
          <Tooltip>Add a block below</Tooltip>
        </TooltipTrigger>
        <span
          aria-hidden
          className="flex size-6.5 cursor-grab items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground active:cursor-grabbing"
        >
          <IconGrip className="size-icon" />
        </span>
      </div>
    </DragHandle>
  );
}

interface Mark {
  name: string;
  label: string;
  icon: typeof IconBold;
  toggle: (editor: Editor) => void;
}

const MARKS: Mark[] = [
  {
    name: "bold",
    label: "Bold",
    icon: IconBold,
    toggle: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    name: "italic",
    label: "Italic",
    icon: IconItalic,
    toggle: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    name: "strike",
    label: "Strikethrough",
    icon: IconStrike,
    toggle: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    name: "code",
    label: "Code",
    icon: IconCode,
    toggle: (e) => e.chain().focus().toggleCode().run(),
  },
];

/** Over selected text: bold, italic, strikethrough and code, and a comment on it. */
export function FormatBar(props: { editor: Editor; onComment?: (() => void) | undefined }) {
  const { editor } = props;
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => MARKS.map((mark) => e.isActive(mark.name)),
  });
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, view, element, from, to }) =>
        from !== to &&
        e.isEditable &&
        (view.hasFocus() || element.contains(document.activeElement)) &&
        !e.isActive("codeBlock") &&
        !e.isActive("image")
      }
      className={cn(popupSurface, "flex min-w-0 items-center gap-0.5 p-1")}
    >
      {MARKS.map((mark, i) => (
        <TooltipTrigger key={mark.name} delay={400}>
          <Button
            intent={active[i] ? "secondary" : "plain"}
            size="sq-xs"
            aria-label={mark.label}
            aria-pressed={active[i]}
            onPress={() => mark.toggle(editor)}
          >
            <mark.icon />
          </Button>
          <Tooltip>{mark.label}</Tooltip>
        </TooltipTrigger>
      ))}
      {props.onComment && (
        <>
          <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
          <TooltipTrigger delay={400}>
            <Button intent="plain" size="sq-xs" aria-label="Comment" onPress={props.onComment}>
              <IconCommentPlain />
            </Button>
            <Tooltip>Comment</Tooltip>
          </TooltipTrigger>
        </>
      )}
    </BubbleMenu>
  );
}
