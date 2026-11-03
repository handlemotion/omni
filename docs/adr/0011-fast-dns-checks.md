# 0011: Fast, explained DNS checks: diagnostics, auto-check, Domain Connect

Date: 2026-11-03 · Status: accepted

## Context

ADR 0010 made checks authoritative (the mail service asks the zone's nameservers) and added
Omni's challenge. A check still answered only "verified" or "waiting", and only when someone
pressed the button. People get stuck on the same few cases: an SPF record already exists, MX
points at their current host, a CNAME sits where a TXT must go, or the value was pasted wrong.

## Decisions

### Per-record diagnostics, pure, in `mail-core`

`@omni/mail-core/dns-diagnostics` reads the nameservers' answers for each expected record and
returns `{ status, message, found, suggestion? }`. Each record is looked up with its own type
plus the type that can conflict with it: the CNAME at a TXT/MX name, the TXT at a CNAME name.
The statuses:

- `ok`, `missing`, `wrong_value` (with what was found);
- `spf_merge` and `spf_multiple`, with the one merged record to use instead (it keeps the
  domain's own `all` policy);
- `mx_elsewhere` (mail moves when it changes) and `mx_extra`;
- `cname_conflict` and `conflict`;
- `unknown`, when the nameservers did not answer.

Unrelated `x=y` TXT records at a name (site verifications) are not called "wrong". The challenge
is compared by hash (ADR 0010), so its verdict takes the match result instead of comparing text.

The messages are written once, here, so web and iOS say the same thing. Unit tests use real
answers recorded from public domains (`fixtures/dns/`).

### The last check is stored

`domain_claims.last_check` (jsonb, additive) holds the verdicts, the zone, the nameservers, the
DNS host and Domain Connect findings. A reload, another device and the realtime push all read
the same verdicts without checking again. Each check runs as one batch of lookups (at most 17
queries for a Purelymail domain).

### DNS host from the nameservers

`detectDnsProvider` maps nameserver suffixes to hosts: Cloudflare, GoDaddy, Namecheap, Route 53,
Google Cloud DNS, Squarespace, Porkbun, Vercel, DigitalOcean and Gandi. Each comes with one line
on where to add records, and a help link. Unknown hosts get no line.

### Auto-check: a Durable Object per claim, pushed over realtime

`DomainWatch` (one per claim, migration `v2`) holds a lease that the DNS page renews:
`POST /api/onboarding/domains/:id/watch` on open, about every minute, and with `reset` when the
tab regains focus, which is when someone has just saved a record. Its alarm then:

1. runs the same idempotent `checkDomain` as the button, at 5 s, 10 s, 30 s, then every 60 s;
2. advances `org_setup` like the routes do;
3. broadcasts `{ type: "domain", domainId }` to the org's owners and admins on the existing
   `Realtime` object. Apps refetch, the same "say what changed, not its contents" rule as mail
   events.

It stops when:

- the lease lapses (the page closed);
- the domain verifies;
- the claim is taken, expired or gone;
- 30 minutes pass.

Every tick counts against the org's check rate limit, and a limited tick is skipped, not queued.

Alternatives considered:

- **The page polling the check endpoint.** It needs no new class, but it stops when the tab
  sleeps and puts the backoff in every client.
- **The `Realtime` object's own alarm.** It is per org and has one alarm, so it would need to
  multiplex claims.

### Domain Connect, behind config

When `DOMAIN_CONNECT_PROVIDER_ID` is set, the first check of a claim:

1. reads `_domainconnect.<zone>`;
2. fetches the host's `/v2/<zone>/settings` (https only, 3 s timeouts);
3. asks the host whether it has our template (`mail` for Purelymail domains, `verify` for the
   challenge alone).

Any failure reads as "not offered". The apply URL carries the challenge value, so it is built
only when the value is in hand (claim or new value) and is signed when a key is configured
(RSA-SHA256, `@omni/crypto`). The page's "Set up automatically" makes a new value first if
needed.

The templates are in `docs/domain-connect/`, with `example.com` in place of a provider id; each
deployment publishes its own. The SPF record uses `SPFM`, so hosts merge it into an existing one.

## Not verified

Domain Connect has not run end to end. No DNS host has our template, and Cloudflare even answers
`unknown template` for the standard's own example. The discovery, URL building and signing are
unit-tested against Cloudflare's recorded settings and an independent RSA verifier. The SPF, MX
and CNAME diagnostics on Purelymail records are unit-tested only, because the Purelymail path
does not run locally (ADR 0007). The e2e suites cover the challenge's verdicts and the auto-check
push on the local authoritative DNS server.
