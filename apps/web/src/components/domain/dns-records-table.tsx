// The DNS records a domain needs, one row each: its type, name and value, whether DNS serves it,
// and a copy button on each value. Started from Domain SDK's DNS records table
// (domain-sdk.dev/docs/components/dns-records-table) and kept to its parts and behaviour (its
// status badges, copy announcements, issue lines, `renderValue` for Omni's ownership value, of
// which only a hash is kept), laid out as a list so it fits a single form column at any width.
//
// Geometry: each record is its own island. Every line (Type, Name, Value) is one 24px row with
// each mark centred on it, so the label, the value and the copy glyph can't drift apart whatever
// their fonts. Values stay on one line, truncated: the copy button is how the whole value is taken.
// Labels sit on the island's 16px inset in a 48px column, values 12px after it, the copy glyphs'
// ink on the right inset. The record's state is a banner attached to the island's foot, in the
// status's fill, its glyph on the labels' axis.
// `pt-2 pb-3`: a 24px row leaves 4px over its text and less under it, so the lines' ink sits
// 16px from the island's top and 17px above the banner (measured).
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

/** Each status's banner: its fill, its glyph, and what it means, in a few words. */
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

/**
 * The record's state, as a banner attached to the foot of its island: the status's fill, its glyph
 * and one short line saying what it means, never wrapping. The full reason (what DNS holds
 * instead) is the banner's tooltip.
 */
function StatusBanner(props: { status: DnsRecord["status"]; messages: string[] }) {
  const meta = statusMeta[props.status];
  const Icon = meta.icon;
  return (
    <p
      // `px-4`: the glyph on the labels' axis (both 16px in from the island's border).
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
        // The 26px button keeps the 24px line (`-my-px`), and its glyph's ink (not the
        // button's box) sits on the row's right inset, under the badge's edge.
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
            // One island per record: its lines, then its status banner attached at the foot.
            // The island: bordered, the status's fill showing as the banner at its foot. The record's
            // lines sit on a white surface flush with it (`-m-px`: its border lies on the island's,
            // so top and sides show one), rounded like the island, so its foot curves into the banner.
            <li
              key={key}
              className={`overflow-hidden rounded-lg border border-border ${statusMeta[record.status].className}`}
            >
              <dl className="-m-px flex flex-col gap-2 rounded-lg border border-border bg-background px-4 pt-2 pb-3 text-foreground">
                <Line label="Type">
                  <span className="font-semibold">{record.type}</span>
                </Line>
                <Line label="Name" {...copyable(record, "name")} />
                {/* A value that can't be shown takes the content and trailing place. */}
                <Line
                  label="Value"
                  {...(shown === undefined ? copyable(record, "value") : { children: shown })}
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
