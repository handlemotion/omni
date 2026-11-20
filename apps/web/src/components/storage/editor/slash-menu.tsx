import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { cn } from "cn";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { dropdownItemStyles, ItemLabel } from "@/components/ui/dropdown";
import { menuStyles } from "@/components/ui/menu";
import { popupSurface } from "@/components/ui/popover";
import { findBlocks, runBlock, type BlockKind } from "./blocks.ts";

/** A row of a menu the editor opens as you type: blocks after `/`, files after `@`. */
export interface MenuItem {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

interface ListProps {
  items: MenuItem[];
  pick: (item: MenuItem) => void;
  label: string;
}

interface ListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const ItemList = forwardRef<ListHandle, ListProps>(function ItemList(props, ref) {
  const { items, pick, label } = props;
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
        const item = items[at];
        if (item) pick(item);
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
      aria-label={label}
      className={cn(popupSurface, menuStyles(), "max-h-80 w-56 min-w-56")}
    >
      {items.map((item, i) => (
        <div
          key={item.id}
          role="option"
          aria-selected={i === at}
          className={dropdownItemStyles({ isFocused: i === at })}
          onMouseEnter={() => setAt(i)}
          onMouseDown={(event) => {
            event.preventDefault();
            pick(item);
          }}
        >
          <item.icon />
          <ItemLabel>{item.label}</ItemLabel>
        </div>
      ))}
    </div>
  );
});

/** Shows a suggestion's items as a menu under the caret, named `label` for assistive tech. */
export function menuRenderer<T extends MenuItem>(label: string) {
  return () => {
    let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
    let unmount: (() => void) | null = null;
    const listProps = (props: SuggestionProps<T, T>) =>
      ({
        items: props.items,
        pick: (item: MenuItem) => props.command(item as T),
        label,
      }) satisfies ListProps;
    return {
      onStart: (props: SuggestionProps<T, T>) => {
        renderer = new ReactRenderer(ItemList, { props: listProps(props), editor: props.editor });
        renderer.element.style.zIndex = "50";
        unmount = props.mount(renderer.element);
      },
      onUpdate: (props: SuggestionProps<T, T>) => renderer?.updateProps(listProps(props)),
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
}

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
        render: menuRenderer<BlockKind>("Blocks"),
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
