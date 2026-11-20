import { Skeleton, SkeletonBox } from "skullet/react";
import {
  IconBuildings,
  IconChecklist,
  IconHandshake,
  IconUserRound,
} from "@/components/icons/central";
import { IconEmail } from "@/components/icons/sidebar";
import { FileGlyph } from "@/components/storage/file-glyph.tsx";
import { CommandDetail, CommandGroup, CommandItem } from "@/components/ui/command";
import type { CrmCompany, CrmDeal, CrmPerson } from "@/lib/crm.ts";
import type { CrmTask } from "@/lib/crm-tasks.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { CommandHits, FileHit } from "@/hooks/use-command-search.ts";
import { senderLabel } from "@/lib/threads.ts";
import type { ThreadSummary } from "@/lib/types.ts";

/**
 * The records each pill shows. Before a query, Mail's pill lists the inbox; after one, mail found
 * anywhere.
 */
export function RecordGroups(props: {
  show: { files: boolean; crm: boolean; messages: boolean };
  query: string;
  hits: CommandHits;
  inbox: readonly ThreadSummary[];
  onNode: (node: FileHit) => void;
  onPath: (path: string) => void;
  onThread: (threadId: string) => void;
}) {
  const { show, hits } = props;
  return (
    <>
      {show.files && <FileGroup nodes={hits.files} onOpen={props.onNode} />}
      {show.crm && <CrmGroups {...hits} onOpen={props.onPath} />}
      {show.messages && (
        <MessageGroup
          heading={props.query ? "Mail" : "Inbox"}
          threads={props.query ? hits.threads : props.inbox}
          onOpen={props.onThread}
        />
      )}
    </>
  );
}

const nodeKind = (node: FileHit) =>
  node.kind === "folder" ? "folder" : fileType(node.name, node.mimeType).kind;

/** Files and folders by name; each opens its folder, a file in the folder's preview. */
export function FileGroup(props: { nodes: FileHit[]; onOpen: (node: FileHit) => void }) {
  if (!props.nodes.length) return null;
  return (
    <CommandGroup heading="Files">
      {props.nodes.map((node) => (
        <CommandItem
          key={node.id}
          value={`node:${node.id}`}
          keywords={[node.name]}
          onSelect={() => props.onOpen(node)}
        >
          <FileGlyph kind={nodeKind(node)} />
          <span className="min-w-0 truncate">{node.name}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/**
 * The CRM's companies, people and deals by name (a person also by address), and open tasks by
 * title; a task opens beside the task list.
 */
export function CrmGroups(props: {
  companies: CrmCompany[];
  people: CrmPerson[];
  deals: CrmDeal[];
  tasks: CrmTask[];
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {props.companies.length > 0 && (
        <CommandGroup heading="Companies">
          {props.companies.map((company) => (
            <CommandItem
              key={company.id}
              value={`company:${company.id}`}
              keywords={[company.name]}
              onSelect={() => props.onOpen(`/crm/companies/${company.id}`)}
            >
              <IconBuildings />
              <span className="min-w-0 truncate">{company.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {props.people.length > 0 && (
        <CommandGroup heading="People">
          {props.people.map((person) => {
            const address = person.addresses[0]?.address;
            return (
              <CommandItem
                key={person.id}
                value={`person:${person.id}`}
                keywords={[person.name, ...person.addresses.map((a) => a.address)]}
                onSelect={() => props.onOpen(`/crm/people/${person.id}`)}
              >
                <IconUserRound />
                <span className="min-w-0 truncate">{person.name || address}</span>
                {person.name && address && <CommandDetail>{address}</CommandDetail>}
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
      {props.deals.length > 0 && (
        <CommandGroup heading="Deals">
          {props.deals.map((deal) => (
            <CommandItem
              key={deal.id}
              value={`deal:${deal.id}`}
              keywords={[deal.name]}
              onSelect={() => props.onOpen(`/crm/deals/${deal.id}`)}
            >
              <IconHandshake />
              <span className="min-w-0 truncate">{deal.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {props.tasks.length > 0 && (
        <CommandGroup heading="Tasks">
          {props.tasks.map((task) => (
            <CommandItem
              key={task.id}
              value={`task:${task.id}`}
              keywords={[task.title]}
              onSelect={() => props.onOpen(`/crm/tasks?assignee=anyone&task=${task.id}`)}
            >
              <IconChecklist />
              <span className="min-w-0 truncate">{task.title}</span>
              {task.recordName && <CommandDetail>{task.recordName}</CommandDetail>}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}

/** Mail matched on subject and sender. */
export function MessageGroup(props: {
  heading: string;
  threads: readonly ThreadSummary[];
  onOpen: (threadId: string) => void;
}) {
  if (!props.threads.length) return null;
  return (
    <CommandGroup heading={props.heading}>
      {props.threads.map((thread) => {
        const sender = senderLabel(thread);
        return (
          <CommandItem
            key={thread.id}
            value={`thread:${thread.id}`}
            keywords={[thread.subject, sender]}
            onSelect={() => props.onOpen(thread.id)}
          >
            <IconEmail />
            <span className="min-w-0 truncate">{thread.subject || "(no subject)"}</span>
            <CommandDetail>{sender}</CommandDetail>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

/** What the list shows while the server looks for names nothing on hand matched. */
export function ResultBones() {
  return (
    <Skeleton
      loading
      label="Searching"
      skeleton={
        <div className="flex flex-col gap-1 px-2">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonBox key={i} width="100%" height={36} radius="var(--radius-lg)" />
          ))}
        </div>
      }
    >
      {null}
    </Skeleton>
  );
}
