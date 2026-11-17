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

export function filterDnsRecords(records: readonly DnsRecord[], filter: DnsRecordFilter) {
  return (
    filter === "required" ? records.filter((record) => record.required) : [...records]
  ) satisfies DnsRecord[];
}

export function issuesForRecord(issues: readonly DomainIssue[], record: DnsRecord) {
  return issues.filter(
    (issue) =>
      issue.record?.type === record.type &&
      issue.record.name === record.name &&
      issue.record.value === record.value &&
      issue.record.purpose === record.purpose,
  ) satisfies DomainIssue[];
}
