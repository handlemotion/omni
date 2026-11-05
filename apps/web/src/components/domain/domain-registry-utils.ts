// From Domain SDK's `dns-records-table` registry item (domain-sdk.dev/r/dns-records-table.json),
// unchanged apart from the types: they are declared here, in the SDK's shape, instead of
// importing `@opencoredev/domain-sdk`, which we would add for its types alone. `type` is a string
// because the SDK's union has no MX, and Omni's mail records need it.

export type DnsRecordStatus = "pending" | "valid" | "invalid" | "unknown";

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: number;
  purpose: "routing" | "ownership" | "certificate" | "other";
  required: boolean;
  status: DnsRecordStatus;
  description?: string;
}

export interface DomainIssue {
  code: string;
  message: string;
  record?: DnsRecord;
  retryable: boolean;
}

export type DnsRecordFilter = "required" | "all";

export function filterDnsRecords(
  records: readonly DnsRecord[],
  filter: DnsRecordFilter,
): DnsRecord[] {
  return filter === "required" ? records.filter((record) => record.required) : [...records];
}

export function issuesForRecord(issues: readonly DomainIssue[], record: DnsRecord): DomainIssue[] {
  return issues.filter(
    (issue) =>
      issue.record?.type === record.type &&
      issue.record.name === record.name &&
      issue.record.value === record.value &&
      issue.record.purpose === record.purpose,
  );
}
