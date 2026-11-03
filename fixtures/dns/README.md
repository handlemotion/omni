# Recorded DNS answers

Real answers for public domains, recorded on 2026-11-03 through Cloudflare's DNS-over-HTTPS JSON
API (`https://cloudflare-dns.com/dns-query?name=<name>&type=<type>`), saved as returned. The
`dns-diagnostics` unit tests read them as the mail service's lookups would see them (`Status` 0
with answers is `found`, 0 without is `nodata`, 3 is `nxdomain`; answers of another type, such as
the CNAME a TXT query follows, are dropped, as `node:dns` does).

`cloudflare.domainconnect-settings.json` is Cloudflare's Domain Connect settings document for a
Cloudflare-hosted zone (`https://api.cloudflare.com/client/v4/dns/domainconnect/v2/discord.com/settings`).

Re-record with the same URLs when a test needs a new case; anonymize anything that is not public.
