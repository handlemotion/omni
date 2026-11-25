import { useEffect, useState } from "react";
import type { LiveDoc } from "../lib/live-doc.ts";

/**
 * How long the doc reads as being edited after an agent's last change. An agent edits in calls a
 * few seconds apart, so this bridges the gaps between them into one stretch of work.
 */
export const AGENT_LINGER_MS = 6_000;

/** The agent's name in an agent edit's author, `a:<memberId>:<agent>` (`storageLiveAuthorSchema`). */
export function agentOf(by: string | undefined) {
  return by?.startsWith("a:") ? by.split(":").slice(2).join(":") : undefined;
}

/** An agent editing the doc: its name, and a count of its edits that ticks with each one. */
export interface AgentAtWork {
  name: string;
  edits: number;
}

/** The agent editing the live doc now, or null when none has for a while. */
export function useAgentEditing(doc: LiveDoc | null) {
  const [agent, setAgent] = useState<AgentAtWork | null>(null);
  useEffect(() => {
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = doc.onUpdate((by) => {
      const name = agentOf(by);
      if (name === undefined) return;
      setAgent((was) => ({ name, edits: (was?.edits ?? 0) + 1 }));
      clearTimeout(timer);
      timer = setTimeout(() => setAgent(null), AGENT_LINGER_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
      setAgent(null);
    };
  }, [doc]);
  return agent;
}
