import { createFileRoute, Outlet } from "@tanstack/react-router";
import type { DragEvent } from "react";
import { crmStagesQuery } from "../../../lib/crm.ts";

/** The CRM. The stages load here: every CRM screen names them. */
export const Route = createFileRoute("/_authed/$workspace/crm")({
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
