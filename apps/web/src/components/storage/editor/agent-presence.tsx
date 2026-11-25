import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IconSparkleFilled } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import type { AgentAtWork } from "@/hooks/use-agent-editing.ts";
import { FACE, faceSpot } from "./collaborator-faces.tsx";

/** A pill above the doc's toolbar naming the agent editing it; it keeps the name as it fades. */
export function AgentPill(props: { agent: AgentAtWork | null }) {
  const last = useRef(props.agent?.name);
  if (props.agent) last.current = props.agent.name;
  return (
    <div
      role="status"
      data-active={props.agent ? "" : undefined}
      className="agent-pill pointer-events-none absolute bottom-16 left-1/2 flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground"
    >
      {last.current && (
        <span aria-hidden={!props.agent} className="contents">
          <IconSparkleFilled className="size-3.5" aria-hidden />
          <span className="shimmer">{last.current} is editing</span>
        </span>
      )}
    </div>
  );
}

/**
 * The agent's face, a sparkle on the accent blue, floating left of the block its last edit
 * changed, as a person's face floats beside the block they are in (`CollaboratorFaces`).
 */
export function AgentFace(props: {
  editor: Editor;
  scroller: HTMLElement | null;
  agent: AgentAtWork | null;
}) {
  const { editor, scroller, agent } = props;
  const changed = useRef<number | null>(null);
  const block = useRef<Element | null>(null);
  const [spot, setSpot] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const heard = ({ transaction }: { transaction: Parameters<typeof isChangeOrigin>[0] }) => {
      if (!transaction.docChanged || !isChangeOrigin(transaction)) return;
      changed.current = transaction.before.content.findDiffStart(transaction.doc.content) ?? null;
    };
    editor.on("transaction", heard);
    return () => void editor.off("transaction", heard);
  }, [editor]);
  useEffect(() => {
    if (!agent || !scroller) return;
    const frame = requestAnimationFrame(() => {
      if (changed.current === null) return;
      const at = Math.min(changed.current, editor.state.doc.content.size);
      const { node } = editor.view.domAtPos(at);
      block.current = node instanceof Element ? node : node.parentElement;
      setSpot(block.current ? faceSpot(scroller, block.current) : null);
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, scroller, agent]);
  useEffect(() => {
    if (!agent || !scroller) return;
    const measure = () => {
      if (block.current?.isConnected) setSpot(faceSpot(scroller, block.current));
    };
    editor.on("transaction", measure);
    const resized = new ResizeObserver(measure);
    resized.observe(scroller);
    return () => {
      editor.off("transaction", measure);
      resized.disconnect();
    };
  }, [editor, scroller, agent]);
  if (!spot) return null;
  return (
    <Avatar
      aria-hidden
      data-agent-face
      data-active={agent ? "" : undefined}
      className="pointer-events-none absolute top-0 left-0 place-items-center bg-primary text-primary-foreground opacity-0 ring-2 ring-background outline-0 transition-[translate,opacity] duration-200 ease-out data-active:opacity-100 motion-reduce:transition-none"
      style={
        { "--avatar-size": `${FACE}px`, translate: `${spot.left}px ${spot.top}px` } as CSSProperties
      }
    >
      <IconSparkleFilled className="size-3!" />
    </Avatar>
  );
}
