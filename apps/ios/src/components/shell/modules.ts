import { IconFolderFilled, IconHandshakeFilled, IconMailFilled } from "@/components/icons.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import type { ColorToken } from "@/theme/tokens.ts";
import type { Module } from "./menu-nav.ts";

const MODULES = [
  { id: "mail", label: "Mail", icon: IconMailFilled, color: "moduleMail" },
  { id: "drive", label: "Drive", icon: IconFolderFilled, color: "moduleDrive" },
  { id: "crm", label: "CRM", icon: IconHandshakeFilled, color: "moduleCrm" },
] as const satisfies readonly { id: Module; label: string; icon: unknown; color: ColorToken }[];

/** The modules this workspace has, in order: no CRM in a Personal space. */
export function useModules() {
  const crm = hasCrm(useWorkspace().active);
  return MODULES.filter((m) => m.id !== "crm" || crm);
}
