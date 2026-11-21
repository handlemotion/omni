import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { cn } from "cn";
import {
  IconBold,
  IconCode,
  IconCommentPlain,
  IconGrip,
  IconItalic,
  IconStrike,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { popupSurface } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

/** Beside the block under the pointer: a grip to drag it somewhere else. */
export function BlockHandle(props: { editor: Editor }) {
  return (
    <DragHandle editor={props.editor}>
      <span
        aria-hidden
        className="document-handle flex size-6.5 cursor-grab items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground active:cursor-grabbing"
      >
        <IconGrip className="size-icon" />
      </span>
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
