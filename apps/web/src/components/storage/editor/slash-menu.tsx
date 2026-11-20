import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { cn } from "cn";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { dropdownItemStyles, ItemLabel } from "@/components/ui/dropdown";
import { menuStyles } from "@/components/ui/menu";
import { popupSurface } from "@/components/ui/popover";
import { findBlocks, runBlock, type BlockKind } from "./blocks.ts";

interface ListProps {
  items: BlockKind[];
  pick: (block: BlockKind) => void;
}

interface ListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const BlockList = forwardRef<ListHandle, ListProps>(function BlockList(props, ref) {
  const { items, pick } = props;
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setAt(0), [items]);
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [at]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (items.length === 0) return false;
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        setAt((now) => (now + step + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const block = items[at];
        if (block) pick(block);
        return true;
      }
      return false;
    },
  }));
  if (items.length === 0) return null;
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Blocks"
      className={cn(popupSurface, menuStyles(), "max-h-80 w-56 min-w-56")}
    >
      {items.map((block, i) => (
        <div
          key={block.id}
          role="option"
          aria-selected={i === at}
          className={dropdownItemStyles({ isFocused: i === at })}
          onMouseEnter={() => setAt(i)}
          onMouseDown={(event) => {
            event.preventDefault();
            pick(block);
          }}
        >
          <block.icon />
          <ItemLabel>{block.label}</ItemLabel>
        </div>
      ))}
    </div>
  );
});

type Props = SuggestionProps<BlockKind, BlockKind>;

const listProps = (props: Props) => ({ items: props.items, pick: props.command });

const renderList = () => {
  let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
  let unmount: (() => void) | null = null;
  return {
    onStart: (props: Props) => {
      renderer = new ReactRenderer(BlockList, { props: listProps(props), editor: props.editor });
      renderer.element.style.zIndex = "50";
      unmount = props.mount(renderer.element);
    },
    onUpdate: (props: Props) => renderer?.updateProps(listProps(props)),
    onKeyDown: (props: SuggestionKeyDownProps) => {
      if (props.event.key === "Escape") {
        unmount?.();
        unmount = null;
        return true;
      }
      return renderer?.ref?.onKeyDown(props.event) ?? false;
    },
    onExit: () => {
      unmount?.();
      renderer?.destroy();
      unmount = null;
      renderer = null;
    },
  };
};

/** Typing `/` at the start of a word opens the blocks to turn this one into. */
export const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion<BlockKind, BlockKind>({
        editor: this.editor,
        pluginKey: new PluginKey("slashMenu"),
        char: "/",
        placement: "bottom-start",
        offset: { mainAxis: 6 },
        items: ({ query }) => findBlocks(query),
        allow: ({ editor }) => !editor.isActive("codeBlock"),
        command: ({ editor, range, props }) => runBlock(editor, range, props),
        render: renderList,
      }),
    ];
  },
});

/** Opens the `/` menu on the block at the cursor, as if `/` were typed there. */
export function openSlashMenu(editor: Editor, at?: Range) {
  const chain = editor.chain().focus();
  if (at) chain.setTextSelection(at);
  chain.insertContent("/").run();
}
