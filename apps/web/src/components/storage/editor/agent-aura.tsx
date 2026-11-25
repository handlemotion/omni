import { useAgentEditing } from "@/hooks/use-agent-editing.ts";
import type { LiveDoc } from "@/lib/live-doc.ts";

/**
 * A blue glow round the page while an agent edits the doc: it fades in with the agent's first
 * change, sweeps round the edges as the changes come, and fades out once they stop. Screen
 * readers hear who is editing instead.
 */
export function AgentAura(props: { doc: LiveDoc | null }) {
  const agent = useAgentEditing(props.doc);
  return (
    <>
      <div aria-hidden data-active={agent ? "" : undefined} className="agent-aura" />
      <span role="status" className="sr-only">
        {agent ? `${agent} is editing` : ""}
      </span>
    </>
  );
}
