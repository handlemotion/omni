import { Redirect, useLocalSearchParams } from "expo-router";
import { LinkFilesScreen } from "@/components/crm/link-files.tsx";

const isKind = (kind: string | undefined): kind is "companies" | "deals" =>
  kind === "companies" || kind === "deals";

/** Picks Drive files to link to a company or a deal where they are (`docs/spec/crm.md`, "Keep the files"). */
export default function Link() {
  const { kind, id, name } = useLocalSearchParams<{ kind?: string; id?: string; name?: string }>();
  if (!isKind(kind) || !id) return <Redirect href="/crm" />;
  return <LinkFilesScreen kind={kind} id={id} name={name ?? ""} />;
}
