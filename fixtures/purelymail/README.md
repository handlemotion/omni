# Purelymail API responses

Bodies of Purelymail admin API answers (`POST https://purelymail.com/api/v0/<method>`), for unit
tests of `packages/mail-core/src/domains.ts`.

`list-domains.json` matches a live `listDomains` answer from Omni's account field for field
(checked 2026-11-13), with the domain names and DNS results anonymized. Every answer is HTTP 200;
success carries `"type": "success"` and `result`, and a refusal carries `"type": "error"`, `code`
and `message` instead (for example `internalError` with "DNS ownership checks did not pass" from
`addDomain`, or "Unknown user …" from `getUser`). The client reads a missing `result` as an error.

| File                | Method        | Schema                                             |
| ------------------- | ------------- | -------------------------------------------------- |
| `list-domains.json` | `listDomains` | `ListDomainsResponse` → `ApiDomainInfo.dnsSummary` |
