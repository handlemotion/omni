import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { DragEvent } from "react";
import { crmStagesQuery } from "../../../lib/crm.ts";

/**
 * The CRM: a company workspace's only. A Personal space has none (the API
 * answers `no_crm`), so its paths open the Inbox instead. The stages load here: every CRM screen
 * names them.
 */
export const Route = createFileRoute("/_authed/$workspace/crm")({
  beforeLoad: ({ context, params }) => {
    if (context.workspace.kind === "personal") {
      throw redirect({ to: "/$workspace/mail/inbox", params });
    }
  },
  loader: ({ context }) => void context.queryClient.prefetchQuery(crmStagesQuery()),
  component: CrmLayout,
});

function CrmLayout() {
  return (
    <div className="contents" onDragStart={stopNativeDrag}>
      <Outlet />
    </div>
  );
}

function stopNativeDrag(event: DragEvent) {
  const node = event.target as Node;
  const target = node instanceof Element ? node : node.parentElement;
  if (target?.closest('[draggable="true"], [contenteditable="true"]')) return;
  event.preventDefault();
}
