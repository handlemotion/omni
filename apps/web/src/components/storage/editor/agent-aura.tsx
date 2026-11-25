import { useRef } from "react";
import { IconSparkle } from "@/components/icons/central";

/**
 * A blue glow rising from the page's bottom edge, behind the toolbar, while an agent edits the
 * doc. Placed before the page's scroller, which paints over it.
 */
export function AgentGlow(props: { agent: string | null }) {
  return <div aria-hidden data-active={props.agent ? "" : undefined} className="agent-aura" />;
}

/** A pill above the doc's toolbar naming the agent editing it; it keeps the name as it fades. */
export function AgentPill(props: { agent: string | null }) {
  const last = useRef(props.agent);
  if (props.agent) last.current = props.agent;
  return (
    <div
      role="status"
      data-active={props.agent ? "" : undefined}
      className="agent-pill pointer-events-none absolute bottom-16 left-1/2 flex items-center gap-1.5 rounded-full border border-primary-subtle bg-overlay px-2.5 py-1 text-xs text-primary"
    >
      {last.current && (
        <span aria-hidden={!props.agent} className="contents">
          <IconSparkle className="size-3.5" aria-hidden />
          <span className="shimmer">{last.current} is editing</span>
        </span>
      )}
    </div>
  );
}
