import { Stack, router } from "expo-router";
import { Alert } from "react-native";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { useAddDomain, useMoveDeal, type CrmRecordKind } from "@/lib/crm-mutations.ts";
import { useStages, type CrmStage } from "@/lib/crm-timeline.ts";
import type { RecordFormKind } from "./record-form-sheet.tsx";

const FORM_KIND: Record<CrmRecordKind, RecordFormKind> = {
  companies: "company",
  people: "person",
  deals: "deal",
};

const openForm = (kind: RecordFormKind, params: { id: string } | { companyId: string }) =>
  router.push({ pathname: "/crm/form", params: { kind, ...params } });

export const openNote = (record: CrmRecordKind, id: string, noteId?: string) =>
  router.push({ pathname: "/crm/note", params: { record, id, ...(noteId ? { noteId } : {}) } });

/**
 * A record screen's header buttons: Edit, then a menu of what else the web's record page does
 * there (a note; a company's domain, people and deals; a deal's stage). The native menu reads
 * its items straight from its children, so they are all built here.
 */
export function RecordActions(props: { kind: CrmRecordKind; id: string; stageId?: string }) {
  const { kind, id } = props;
  const stages = useStages().data ?? [];
  const move = useMoveDeal();
  const addDomain = useAddDomain();
  const moveTo = (stage: CrmStage) =>
    stage.id !== props.stageId &&
    move.mutate(
      { dealId: id, stage },
      { onError: (error) => crmErrorAlert(error, "The deal was not moved") },
    );
  const promptDomain = () =>
    Alert.prompt(
      "Add domain",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Add",
          isPreferred: true,
          onPress: (text?: string) => {
            const domain = text?.trim().toLowerCase();
            if (!domain) return;
            addDomain.mutate(
              { id, domain },
              { onError: (error) => crmErrorAlert(error, "The domain was not added") },
            );
          },
        },
      ],
      "plain-text",
      "",
      "url",
    );
  const company = kind === "companies";
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button onPress={() => openForm(FORM_KIND[kind], { id })}>
        Edit
      </Stack.Toolbar.Button>
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
        {kind === "deals" && stages.length ? (
          <Stack.Toolbar.Menu title="Stage" icon="flag">
            {stages.map((stage) => (
              <Stack.Toolbar.MenuAction
                key={stage.id}
                isOn={stage.id === props.stageId}
                onPress={() => moveTo(stage)}
              >
                {stage.name}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        ) : null}
        <Stack.Toolbar.MenuAction icon="square.and.pencil" onPress={() => openNote(kind, id)}>
          Add note
        </Stack.Toolbar.MenuAction>
        {company ? (
          <Stack.Toolbar.MenuAction icon="globe" onPress={promptDomain}>
            Add domain
          </Stack.Toolbar.MenuAction>
        ) : null}
        {company ? (
          <Stack.Toolbar.MenuAction
            icon="person.badge.plus"
            onPress={() => openForm("person", { companyId: id })}
          >
            Add person
          </Stack.Toolbar.MenuAction>
        ) : null}
        {company ? (
          <Stack.Toolbar.MenuAction
            icon="briefcase"
            onPress={() => openForm("deal", { companyId: id })}
          >
            Add deal
          </Stack.Toolbar.MenuAction>
        ) : null}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}
