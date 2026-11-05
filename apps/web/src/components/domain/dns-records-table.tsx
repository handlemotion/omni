// Domain SDK's DNS records table (domain-sdk.dev/docs/components/dns-records-table), installed from
// its registry item and kept to its design: layout, spacing, copy behavior, announcements and
// copy. Only the parts are ours: its shadcn Badge, Button, NativeSelect and Table are our Intent
// UI ones, its Hugeicons are Lucide, and its status colors are our tokens (the badge intents).
// One addition: `renderValue`, for a record whose value can't be shown (Omni's ownership value,
// of which only a hash is kept).
import * as React from "react";
import type { ReactNode } from "react";
import {
  IconCircleCheck,
  IconCircleHelp,
  IconClock3,
  IconCopy,
  IconTriangleAlert,
} from "@/components/icons/lucide";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectContent } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  /** Shown in place of a record's copyable value when it returns something. */
  renderValue?(record: DnsRecord): ReactNode;
}

const statusMeta = {
  valid: { label: "Valid", icon: IconCircleCheck, intent: "success" },
  pending: { label: "Pending", icon: IconClock3, intent: "warning" },
  invalid: { label: "Invalid", icon: IconTriangleAlert, intent: "danger" },
  unknown: { label: "Unknown", icon: IconCircleHelp, intent: "outline" },
} as const;

const copyableFieldClassName = {
  desktop:
    "h-auto min-h-12 w-full touch-manipulation justify-between rounded-none px-4 py-3 text-left whitespace-normal",
  mobile:
    "h-auto min-h-10 w-full touch-manipulation justify-between rounded-md px-2 py-2 text-left whitespace-normal",
} as const;

const copyFeedbackClassName = {
  copied:
    "inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground opacity-100 transition-opacity duration-150 motion-reduce:transition-none",
  idle: "inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground opacity-60 transition-opacity duration-150 motion-reduce:transition-none md:opacity-0 md:group-hover/button:opacity-100 md:group-focus-visible/button:opacity-100",
} as const;

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

function CopyableRecordField({
  record,
  field,
  copied,
  mobile = false,
  onCopy,
}: {
  record: DnsRecord;
  field: DnsRecordCopyField;
  copied: boolean;
  mobile?: boolean;
  onCopy(record: DnsRecord, field: DnsRecordCopyField): void | Promise<void>;
}) {
  return (
    <Button
      intent="plain"
      className={`group/button ${copyableFieldClassName[mobile ? "mobile" : "desktop"]}`}
      onPress={() => void onCopy(record, field)}
      aria-label={`Copy ${field} for ${record.name}`}
    >
      <code className="block min-w-0 break-all text-xs text-foreground" translate="no">
        {record[field]}
      </code>
      <span className={copyFeedbackClassName[copied ? "copied" : "idle"]} aria-hidden="true">
        {copied ? <IconCircleCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </span>
    </Button>
  );
}

export function DnsRecordsTable({
  records,
  issues = [],
  defaultFilter = "required",
  onCopy,
  renderValue,
}: DnsRecordsTableProps) {
  const headingId = React.useId();
  const [filter, setFilter] = React.useState<DnsRecordFilter>(defaultFilter);
  const [copiedField, setCopiedField] = React.useState<string>();
  const [announcement, setAnnouncement] = React.useState("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const visibleRecords = filterDnsRecords(records, filter);
  const hasOptionalRecords = records.some((record) => !record.required);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  function showCopied(key: string) {
    setCopiedField(key);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopiedField(undefined), 1800);
  }

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

    showCopied(fieldKey(record, field));
    setAnnouncement(`Copied the ${field} for ${record.name}.`);
  }

  async function copyAll() {
    const combined = visibleRecords
      .filter((record) => !renderValue?.(record))
      .map((record) => `${record.type}\t${record.name}\t${record.value}`)
      .join("\n");

    try {
      await navigator.clipboard.writeText(combined);
      showCopied("all");
      setAnnouncement(`Copied ${visibleRecords.length} DNS records.`);
    } catch {
      setAnnouncement(
        "Could not copy the DNS records. Check clipboard permissions, then try again.",
      );
    }
  }

  const valueOf = (record: DnsRecord, mobile = false) =>
    renderValue?.(record) ?? (
      <CopyableRecordField
        record={record}
        field="value"
        copied={copiedField === fieldKey(record, "value")}
        mobile={mobile}
        onCopy={copyField}
      />
    );

  const rows = visibleRecords.flatMap((record, index) => {
    const key = `${record.type}:${record.name}:${record.value}`;
    const recordIssues = issuesForRecord(issues, record);
    return [
      <TableRow key={`${key}:${index}`} id={`${key}:${index}`}>
        <TableCell className="px-4 py-3 first:ps-4">
          <span className="text-xs font-semibold">{record.type}</span>
        </TableCell>
        <TableCell className="p-0 whitespace-normal">
          <CopyableRecordField
            record={record}
            field="name"
            copied={copiedField === fieldKey(record, "name")}
            onCopy={copyField}
          />
        </TableCell>
        <TableCell className="p-0 whitespace-normal">{valueOf(record)}</TableCell>
        <TableCell className="px-4 py-3 last:pe-4">
          <RecordStatus status={record.status} />
        </TableCell>
      </TableRow>,
      ...recordIssues.map((issue) => (
        <TableRow
          key={`${key}:${issue.code}`}
          id={`${key}:${issue.code}`}
          className="bg-danger-subtle/40 hover:bg-danger-subtle/40"
        >
          <TableCell
            colSpan={4}
            className="px-4 py-2.5 text-xs whitespace-normal text-danger-subtle-foreground first:ps-4"
          >
            {issue.message} Update this record, then refresh the domain.
          </TableCell>
        </TableRow>
      )),
    ];
  });

  return (
    <section aria-labelledby={headingId} className="min-w-0 text-foreground">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-sm font-semibold">
            DNS records
          </h2>
          <p className="text-sm text-muted-foreground">
            Click any name or value to copy it, then add the records at your DNS provider.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasOptionalRecords ? (
            <NativeSelect className="w-auto">
              <NativeSelectContent
                value={filter}
                onChange={(event) => setFilter(event.target.value as DnsRecordFilter)}
                aria-label="Filter DNS records"
              >
                <option value="required">Required</option>
                <option value="all">All records</option>
              </NativeSelectContent>
            </NativeSelect>
          ) : null}
          <Button
            intent="outline"
            size="sm"
            isDisabled={visibleRecords.length === 0}
            onPress={() => void copyAll()}
          >
            {copiedField === "all" ? <IconCircleCheck /> : <IconCopy />}
            {copiedField === "all" ? "Copied" : "Copy all"}
          </Button>
        </div>
      </header>

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="hidden md:block">
          <Table aria-label="DNS records" bleed className="[--gutter:0]">
            <TableHeader className="bg-muted/40">
              <TableColumn className="h-9 w-24 px-4 text-xs text-muted-foreground first:ps-4">
                Type
              </TableColumn>
              <TableColumn isRowHeader className="h-9 w-[30%] px-4 text-xs text-muted-foreground">
                Name
              </TableColumn>
              <TableColumn className="h-9 px-4 text-xs text-muted-foreground">Value</TableColumn>
              <TableColumn className="h-9 w-24 px-4 text-xs text-muted-foreground last:pe-4">
                Status
              </TableColumn>
            </TableHeader>
            <TableBody
              renderEmptyState={() => (
                <p className="flex h-20 items-center justify-center px-4 text-sm text-muted-foreground">
                  No DNS records in this view.
                </p>
              )}
            >
              {rows}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y divide-border md:hidden">
          {visibleRecords.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No DNS records in this view.
            </p>
          ) : null}
          {visibleRecords.map((record) => {
            const key = `${record.type}:${record.name}:${record.value}`;
            const recordIssues = issuesForRecord(issues, record);

            return (
              <article key={key} className="flex flex-col gap-3 px-4 py-4">
                <header className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold">{record.type}</span>
                  <RecordStatus status={record.status} />
                </header>
                <dl className="grid gap-2">
                  <div className="grid gap-0.5">
                    <dt className="px-2 text-xs text-muted-foreground">Name</dt>
                    <dd>
                      <CopyableRecordField
                        record={record}
                        field="name"
                        copied={copiedField === fieldKey(record, "name")}
                        mobile
                        onCopy={copyField}
                      />
                    </dd>
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="px-2 text-xs text-muted-foreground">Value</dt>
                    <dd>{valueOf(record, true)}</dd>
                  </div>
                </dl>
                {recordIssues.map((issue) => (
                  <p key={issue.code} className="text-xs text-danger-subtle-foreground">
                    {issue.message} Update this record, then refresh the domain.
                  </p>
                ))}
              </article>
            );
          })}
        </div>

        <p className="border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          DNS changes can take time to propagate. Keep the names and values exactly as shown.
        </p>
      </div>

      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
