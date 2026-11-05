// The DNS records a domain needs, one row each: its type, name and value, whether DNS serves it,
// and a copy button on each value. Started from Domain SDK's DNS records table
// (domain-sdk.dev/docs/components/dns-records-table) and kept to its parts and behaviour (its
// status badges, copy announcements, issue lines, `renderValue` for Omni's ownership value, of
// which only a hash is kept), laid out as a list so it fits a single form column at any width.
//
// Geometry: every line (Type, Name, Value) is one 24px row with each mark centred on it, so the
// label, the value, the badge and the copy glyph can't drift apart whatever their fonts. Values
// stay on one line, truncated: the copy button is how the whole value is taken. Labels sit on the
// row's left inset in a 48px column, values 12px after it, and the badge's edge and the copy
// glyph's ink share the right inset. A problem reads under the lines, on the value axis.
// `pb-3`: the last line's 24px row leaves 4px under its text, so the ink sits 16px from the
// bottom as from the top (the badge fills its row).
import * as React from "react";
import type { ReactNode } from "react";
import {
  IconCheck,
  IconCircleCheck,
  IconCircleHelp,
  IconClock3,
  IconCopy,
  IconTriangleAlert,
} from "@/components/icons/lucide";
import { Badge } from "@/components/ui/badge";
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
  valid: { label: "Valid", icon: IconCircleCheck, intent: "success" },
  pending: { label: "Pending", icon: IconClock3, intent: "warning" },
  invalid: { label: "Invalid", icon: IconTriangleAlert, intent: "danger" },
  unknown: { label: "Unknown", icon: IconCircleHelp, intent: "outline" },
} as const;

/** One line of a record: label, content, trailing mark, centred on one row of at least 24px. */
function Line(props: { label: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-3">
      <dt className="w-12 shrink-0 text-xs/4 text-muted-foreground">{props.label}</dt>
      <dd className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span className="min-w-0 flex-1 text-xs/4">{props.children}</span>
        {props.trailing}
      </dd>
    </div>
  );
}

function RecordStatus({ status }: { status: DnsRecord["status"] }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <Badge intent={meta.intent}>
      <Icon aria-hidden="true" className="size-3.5" />
      {meta.label}
    </Badge>
  );
}

function CopyButton(props: { label: string; copied: boolean; onPress: () => void }) {
  return (
    <TooltipTrigger delay={300}>
      <Button
        intent="plain"
        size="sq-xs"
        // The 26px button keeps the 24px line (`-my-px`), and its glyph's ink (not the
        // button's box) sits on the row's right inset, under the badge's edge.
        className="-my-px -me-1.5 text-muted-foreground hover:text-foreground"
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
        // Inter like the labels, not the system monospace (a different font on every machine,
        // each at its own height): one font keeps one baseline. Copy takes the exact value.
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
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
        {visibleRecords.length === 0 && (
          <li className="p-4 text-center text-xs/4 text-muted-foreground">
            No DNS records in this view.
          </li>
        )}
        {visibleRecords.map((record) => {
          const key = `${record.type}:${record.name}:${record.value}`;
          const shown = renderValue?.(record);
          return (
            <li key={key} className="px-4 pt-4 pb-3">
              <dl className="flex flex-col gap-2">
                <Line label="Type" trailing={<RecordStatus status={record.status} />}>
                  <span className="font-semibold">{record.type}</span>
                </Line>
                <Line label="Name" {...copyable(record, "name")} />
                {/* A value that can't be shown takes the content and trailing place. */}
                <Line
                  label="Value"
                  {...(shown === undefined ? copyable(record, "value") : { children: shown })}
                />
                {issuesForRecord(issues, record).map((issue) => (
                  <dd
                    key={issue.code}
                    className="flex min-h-6 items-center ps-15 pb-1 text-xs/4 text-danger-subtle-foreground"
                  >
                    {issue.message}
                  </dd>
                ))}
              </dl>
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
