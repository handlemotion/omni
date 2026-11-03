# Purelymail API responses

Bodies of Purelymail admin API answers (`POST https://purelymail.com/api/v0/<method>`), for unit
tests of `packages/mail-core/src/domains.ts`.

These are **not recorded from the live API**: nobody has run them against Omni's Purelymail
account yet. Each one follows the published OpenAPI schema at
https://news.purelymail.com/api/swagger-spec.js field for field (read 2026-11-03). Replace a
file with a real, anonymized answer the first time one is captured, and fix the code if it
differs.

| File                | Method        | Schema                                             |
| ------------------- | ------------- | -------------------------------------------------- |
| `list-domains.json` | `listDomains` | `ListDomainsResponse` → `ApiDomainInfo.dnsSummary` |
