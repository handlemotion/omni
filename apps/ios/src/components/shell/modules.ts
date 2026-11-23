import type { ComponentType } from "react";
import {
  IconCalendarMark,
  IconCrmMark,
  IconDriveMark,
  IconMailMark,
  type ModuleMarkProps,
} from "@/components/brand/module-marks.tsx";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import type { ColorToken } from "@/theme/tokens.ts";
import type { Module } from "./menu-nav.ts";

export interface ModuleEntry {
  id: Module;
  label: string;
  mark: ComponentType<ModuleMarkProps>;
  color: ColorToken;
}

const MODULES: readonly ModuleEntry[] = [
  { id: "mail", label: "Mail", mark: IconMailMark, color: "moduleMail" },
  { id: "drive", label: "Drive", mark: IconDriveMark, color: "moduleDrive" },
  { id: "crm", label: "CRM", mark: IconCrmMark, color: "moduleCrm" },
  { id: "calendar", label: "Calendar", mark: IconCalendarMark, color: "moduleCalendar" },
];

/** The modules this workspace has, in desktop rail order: no CRM in a Personal space. */
export function useModules() {
  const crm = hasCrm(useWorkspace().active);
  return MODULES.filter((m) => m.id !== "crm" || crm);
}
