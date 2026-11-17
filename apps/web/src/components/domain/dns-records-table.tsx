import * as React from "react";
import type { ReactNode } from "react";
import {
  IconCheck,
  IconCircleCheck,
  IconCircleHelp,
  IconClock3,
  IconCopy,
  IconTriangleAlert,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import {
  filterDnsRecords,
  issuesForRecord,
  type DnsRecord,
  type DnsRecordFilter,
  type DomainIssue,
} from "@/components/domain/domain-registry-utils";

export type DnsRecordCopyField = "name" | "value";

export interface DnsRecordsTableProps {
  records: readonly DnsRecord[];
  issues?: readonly DomainIssue[];
  defaultFilter?: DnsRecordFilter;
  onCopy?(content: string, record: DnsRecord, field: DnsRecordCopyField): void | Promise<void>;
  /** Shown in place of a record's value (and its copy button) when it returns something. */
  renderValue?(record: DnsRecord): ReactNode;
}

const statusMeta = {
  valid: {
    icon: IconCircleCheck,
    className: "bg-success-subtle text-success-subtle-foreground",
    text: "Found in your DNS.",
  },
  pending: {
    icon: IconClock3,
    className: "bg-warning-subtle text-warning-subtle-foreground",
    text: "Not found yet. DNS can take a few minutes.",
  },
  invalid: {
    icon: IconTriangleAlert,
    className: "bg-danger-subtle text-danger-subtle-foreground",
    text: "Another value is in DNS. Replace it with this one.",
  },
  unknown: {
    icon: IconCircleHelp,
    className: "bg-muted text-muted-foreground",
    text: "Not checked yet.",
  },
} as const;

function Line(props: { label: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-3">
      <dt className="w-12 shrink-0 text-xs/4 text-muted-foreground">{props.label}</dt>
      <dd className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span className="min-w-0 flex-1 text-end text-xs/4">{props.children}</span>
        {props.trailing === undefined ? (
          <span aria-hidden className="w-5 shrink-0" />
        ) : (
          props.trailing
        )}
      </dd>
    </div>
  );
}

function StatusBanner(props: { status: DnsRecord["status"]; messages: string[] }) {
  const meta = statusMeta[props.status];
  const Icon = meta.icon;
  return (
    <p
      className="flex items-center gap-2 px-4 py-2.5 text-xs/4"
      title={props.messages.length > 0 ? props.messages.join(" ") : undefined}
    >
      <Icon aria-hidden="true" className="size-3.25 shrink-0" />
      <span className="min-w-0 truncate">{meta.text}</span>
    </p>
  );
}

function CopyButton(props: { label: string; copied: boolean; onPress: () => void }) {
  return (
    <TooltipTrigger delay={300}>
      <Button
        intent="plain"
        size="sq-xs"
        className="-my-px -me-1.5 text-muted-foreground *:[svg]:size-3.25 hover:text-foreground"
        aria-label={props.label}
        onPress={props.onPress}
      >
        {props.copied ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}
      </Button>
      <Tooltip arrow={false}>{props.copied ? "Copied" : "Copy"}</Tooltip>
    </TooltipTrigger>
  );
}

export function DnsRecordsTable({
  records,
  issues = [],
  defaultFilter = "required",
  onCopy,
  renderValue,
}: DnsRecordsTableProps) {
  const [copiedField, setCopiedField] = React.useState<string>();
  const [announcement, setAnnouncement] = React.useState("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const visibleRecords = filterDnsRecords(records, defaultFilter);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  function fieldKey(record: DnsRecord, field: DnsRecordCopyField) {
    return `${field}:${record.type}:${record.name}:${record.value}`;
  }

  async function copyField(record: DnsRecord, field: DnsRecordCopyField) {
    const content = record[field];
    try {
      if (onCopy) await onCopy(content, record, field);
      else await navigator.clipboard.writeText(content);
    } catch {
      setAnnouncement(
        `Could not copy the ${field} for ${record.name}. Check clipboard permissions, then try again.`,
      );
      return;
    }
    setCopiedField(fieldKey(record, field));
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopiedField(undefined), 1800);
    setAnnouncement(`Copied the ${field} for ${record.name}.`);
  }

  const copyable = (record: DnsRecord, field: DnsRecordCopyField) => ({
    children: (
      <span
        className="block truncate text-xs/4 text-foreground"
        translate="no"
        title={record[field]}
      >
        {record[field]}
      </span>
    ),
    trailing: (
      <CopyButton
        label={`Copy ${field} for ${record.name}`}
        copied={copiedField === fieldKey(record, field)}
        onPress={() => void copyField(record, field)}
      />
    ),
  });

  return (
    <section aria-label="DNS records" className="min-w-0 text-foreground">
      <ul className="flex flex-col gap-3">
        {visibleRecords.length === 0 && (
          <li className="rounded-lg border border-border p-4 text-center text-xs/4 text-muted-foreground">
            No DNS records in this view.
          </li>
        )}
        {visibleRecords.map((record) => {
          const key = `${record.type}:${record.name}:${record.value}`;
          const shown = renderValue?.(record);
          return (
            <li
              key={key}
              className={`overflow-hidden rounded-lg border border-border ${statusMeta[record.status].className}`}
            >
              <dl className="-m-px flex flex-col gap-2 rounded-lg border border-border bg-background px-4 pt-2 pb-3 text-foreground">
                <Line label="Type">
                  <span>{record.type}</span>
                </Line>
                <Line label="Name" {...copyable(record, "name")} />
                <Line
                  label="Value"
                  {...(shown === undefined
                    ? copyable(record, "value")
                    : { children: shown, trailing: null })}
                />
              </dl>
              <StatusBanner
                status={record.status}
                messages={issuesForRecord(issues, record).map((issue) => issue.message)}
              />
            </li>
          );
        })}
      </ul>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
