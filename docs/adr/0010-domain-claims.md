# 0010: Domain claims: Omni's own ownership proof, the lock, and authoritative DNS

Date: 2026-11-03 · Status: accepted

## Context

ADR 0007 locked a domain to the first workspace that typed it. The only proof was Purelymail's
ownership TXT, which is one value per Purelymail account: every workspace on our account shows
the same code, so it cannot tell our workspaces apart. ADR 0007 called this out as the gap to
close before outside customers. Without the Purelymail token there was no proof at all.

Checks were also slow to turn green. Public resolvers cache answers, including "no such record"
(negative caching, often 30 minutes to an hour), so a record someone just saved can read as
missing for a long time.

## Decisions

### A per-claim challenge, stored as a hash

Adding a domain opens a **claim** (`domain_claims`, one row per org and domain) with a random
32-byte token. The member publishes it as a TXT record at `_omni-challenge.<domain>`, value
`omni-challenge=<token>`. Only the SHA-256 of the value is stored. The value is in the API
response once, when it is made; the web app keeps it in `localStorage` for a reload, and a member
on another device asks for a new value (`POST /api/onboarding/domains/:id/challenge`). A check
hashes every TXT value found and compares digests in constant time (`@omni/crypto`).

This applies to both paths. A self-hoster on the IMAP path adds one TXT record that it did not
need before.

### First to verify wins; pending claims expire

Many workspaces may hold a pending claim on the same domain, so nobody can squat on a name by
claiming it first. The first workspace whose challenge is in DNS locks it. The lock is its
`mail_domains` row, unique on the domain and sharing the claim's id, and it is created in one
transaction:

1. An advisory lock on the domain's last two labels serializes parent and child claims
   (`acme.com` against `mail.acme.com`).
2. Refuse if another workspace locks the domain or a parent of it.
3. `insert ... on conflict (domain) do nothing`: of two racing workspaces, one row wins.
4. `update domain_claims set status = 'verified' where status = 'pending' and expires_at > now()`.
   If that matches nothing because the claim expired, roll back.

Pending claims expire after 7 days. An expired claim cannot verify, does not count toward the
cap, and is renewed (new token) when the domain is added again. Adding a domain the workspace
already has a live claim on returns that claim without a new token, so a record already
published stays valid. A workspace may hold 5 pending claims (`MAX_PENDING_CLAIMS`), counted
under a per-org advisory lock.

The provider's records (Purelymail's) are read before the claim (`/provision/domain` with
`add: false`) and shown with the challenge, so a member adds everything in one visit to their
DNS host. The domain is added to the Purelymail account only after it is locked.

Locks from before this change have no claim. They keep their lock and skip the scheduled
re-check.

### Names

`parseDomain` (`mail-core`) normalizes to lowercase punycode as before, and also:

- refuses punycode that does not decode, or is not the canonical encoding;
- refuses a label that mixes scripts (a Cyrillic "а" in "pаypal"), except the mixes Japanese,
  Chinese and Korean use (Latin, Han and kana, Bopomofo or Hangul);
- refuses a label made only of Cyrillic letters that look Latin ("аррӏе") unless the top-level
  domain is Cyrillic;
- refuses invisible format characters.

Whole-script lookalikes in other scripts (Greek, for example) are not covered. Browsers keep
longer lists; this is the common case.

A lock covers subdomains: another workspace cannot claim `mail.acme.com` while `acme.com` is
locked. The reverse is allowed, since whoever controls `acme.com`'s DNS controls its subdomains
anyway; the child's lock stays where it is.

### Lost DNS pauses sending; it never releases

The Worker's cron trigger (every six hours, `triggers.crons`) re-reads every verified lock's
challenge. A definite answer that the record is gone (missing, or not the right value) sets
`mail_domains.dns_lost_at`. A name that gives no answer (timeout, SERVFAIL) is skipped, so a DNS
outage pauses nobody. A manual check records the same state. While `dns_lost_at` is set, the mail
service's outbox defers sends from that domain without spending attempts, checking again every
five minutes. The lock stays, so a short DNS mistake or a hijack attempt cannot hand the domain
to someone else. Each change, lost or restored, is one conditional update. It produces one
audit event and one email to every owner (from `SYSTEM_MAIL_FROM`, keyed on the audit event).

A verified claim may rotate its challenge too, for an owner who deleted the record and lost the
value. It keeps the lock and reads as lost until DNS holds the new value.

### Release and transfer

Owners only (not admins):

- `POST /api/onboarding/domains/:id/release` deletes the lock, and the claim becomes `released`.
- `POST /api/onboarding/domains/:id/transfer { organizationId }` moves the lock and its verified
  claim to another workspace where the caller is an owner or admin. The challenge in DNS stays
  valid, and the destination's own pending claim on the domain is dropped.

Both are refused while the workspace has mailboxes on the domain. Their mail rows belong to the
workspace, and moving them is not in scope. Every owner of each affected workspace is emailed.

### Limits and audit

- **Rate limits:** Workers Rate Limiting bindings, keyed by org. Adding domains and making new
  values: 10 a minute. Checks: 30 a minute. These limits are approximate per Cloudflare location,
  which is enough to stop loops and scripts.
- **Audit log:** `audit_events` (org, actor, dotted action, subject, data), append-only. It holds
  `domain.claimed`, `challenge_rotated`, `verified`, `claim_refused`, `dns_lost`, `dns_restored`,
  `released`, `transferred_out` and `transferred_in`. Owners and admins read a domain's history at
  `GET /api/onboarding/domains/:id/events`.

### DNS lookups run in the mail service, against the zone's nameservers

The mail service gains a signed `POST /dns/lookup` (`@omni/contracts`). For a domain it:

1. finds the closest enclosing zone's NS records through an ordinary resolver (`DNS_RESOLVERS`,
   or the system's; NS records rarely change);
2. resolves the nameservers' addresses;
3. asks them directly, with a fresh resolver each time so nothing is cached between checks.

A name that the nameservers do not answer falls back to the recursive resolver, and the answer
is marked `recursive`.

Why not the Worker:

- **DNS over HTTPS (DoH):** a DoH resolver is still a cache. There is no standard way to bust
  it, and negative answers are cached as long as positive ones. Cloudflare's own DoH, which the
  image proxy uses, is no exception.
- **Raw DNS from the Worker:** a Worker can open outbound TCP sockets, but not to Cloudflare's
  own addresses. Those are the nameservers of every Cloudflare-hosted zone, one of the most common
  DNS hosts.

The mail service is a plain Node process (on Fly) that can send UDP and TCP to port 53 anywhere.
It is the one service that already talks to mail infrastructure, and it holds no new secret for
this. The Worker still owns every decision: it hashes and compares, it locks, and it audits.

## Consequences

- Every new domain needs one more TXT record, and it must stay in DNS.
- The mail service needs outbound DNS. On Fly that is the default.
- `dns-packet` is a dev dependency of the Worker, for the e2e suites' local authoritative DNS
  server. Production uses Node's `node:dns`.
- Not covered: moving a domain that has mailboxes, and whole-script lookalikes beyond Cyrillic.
