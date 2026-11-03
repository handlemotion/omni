# 0007: Onboarding: workspaces, domains and mailboxes from the web app

Date: 2026-11-03 · Status: accepted

## Context

Until now an install started from the command line: `org:create` made the organization and its
owner, `mailbox:add` added each mailbox, and the Purelymail domain was set up by hand
(`docs/operations/domain-setup.md`). The web app has an onboarding flow (`/onboarding`: workspace
and domain, DNS, mailboxes, invite) that needs a backend. The spec's rules still hold: only the
mail service holds the Purelymail token and mailbox passwords; Purelymail is optional behind the
mailbox `provider`; every job is safe to run twice.

## Decisions

### Workspace: Better Auth's own endpoint, behind a creation policy

The workspace is `organization.create` from Better Auth's organizations plugin, which already
makes the creator `owner` and sets the organization active. Until now the plugin had
`allowUserToCreateOrganization: false`. Now `ORGANIZATION_CREATION` decides:

- `owners` (default): someone who already owns an organization may create another. The first
  one still comes from `org:create`.
- `anyone`: any signed-in user. Sign-up stays invitation-only, so this only widens who may
  create a workspace, not who may have an account.

The default is `owners` because a workspace can create users on the deployment's Purelymail
account. Someone who declined an invitation or was removed from their org should not get that.

Route guards: a signed-in user with no organization goes to `/onboarding` when they may create
one, and to `/login?error=no_organization` otherwise. An owner or admin whose workspace has no
mailboxes goes to `/onboarding`, which resumes at the step where they stopped.

### The mail service gains two signed routes

The spec gives the mail service one private route (`/ping`). Onboarding needs request and
response calls, so it also serves `POST /provision/domain` and `POST /provision/mailbox`. They are
verified with the same `hmacVerifier` (from `@omni/crypto`, with a nonce accepted once), and their
shapes live in `@omni/contracts`. Worker routes: `GET /api/onboarding`, `POST
/api/onboarding/domains`, `POST /api/onboarding/domains/:id/check`, and `POST
/api/onboarding/mailboxes` (owners and admins only).

### Domains: a `mail_domains` table, unique across orgs

The spec's data model has no domains. Onboarding needs one: it records which workspace claimed a
domain, so no other workspace can create mailboxes on it through the provider API. It also keeps
the DNS records with their last check. The table is additive, with `org_id`, unique on the
normalized domain (lowercase punycode, no trailing dot; `normalizeDomain` in `mail-core`). The
upsert never takes over another org's row. Reads go through member-scoped functions limited to
owners and admins (`listMemberDomains`, `findMemberDomain`), with an isolation case in
`for-member.e2e.test.ts`.

With `PURELYMAIL_API_TOKEN`, the mail service:

1. reads the account's ownership code (`getOwnershipCode`) and builds the records from
   Purelymail's documentation: ownership TXT, MX, SPF, three DKIM CNAMEs and the DMARC CNAME,
   with full host names so subdomains stay right;
2. calls `addDomain` if the domain is not on the account yet. Purelymail refuses until the
   ownership record is in DNS, and its reason is shown to the member;
3. otherwise asks Purelymail to recheck (`updateDomainSettings` with `recheckDns`);
4. reads `listDomains` and marks each record from its `dnsSummary` (`passesMx`, `passesSpf`,
   `passesDkim`, `passesDmarc`; ownership counts as verified once the domain is on the account).

Without the token the answer is `provider: "imap"`: the domain stays on its mail host, there are
no records, and the DNS page asks for that host's IMAP and SMTP servers instead.

The per-domain claim does not prove that a workspace controls the domain beyond what Purelymail
checked when it was added to our account. That is enough while every workspace is ours. Before
outside customers, a claim needs its own proof (for example an Omni TXT token).

Superseded by ADR 0010: a claim now needs Omni's own `_omni-challenge` TXT, and the lock is made
only once it verifies.

### Mailboxes: created by the mail service, idempotent on (org, address)

- **Purelymail:** if the address is not in `listUser`, the mail service creates the user. It
  passes `createUser` a random password that is never stored (Omni signs in only with app
  passwords; the person sets a real one in Purelymail if they want another mail client), and
  `sendWelcomeEmail: false`. Then it creates an app password named `Omni`, seals it with
  `MAIL_CREDENTIALS_KEY` (AES-256-GCM, bound to the mailbox id), and writes `mailboxes` plus an
  owner grant in `mailbox_access` (`saveMailbox`). A repeat for an existing Purelymail mailbox
  returns it without a second app password. A crash between creating the app password and saving
  it leaves one unused app password on Purelymail; it is harmless and revocable.
- **IMAP:** the login is checked over IMAP before it is stored. A repeat with the same login
  changes nothing. A new login replaces the stored one and reconnects the mailbox.
- The natural key (org, address) is the idempotency key, as for every other writer. Concurrent
  requests for one address share one run (the service is a single machine, ADR 0004).
- The new mailbox connects at once, and its first sync imports history.
- `kind`: the creator's own address is `personal`, every other address is `shared`. The creator
  gets the owner grant on each. Granting an invited teammate their own mailbox when they join is
  not done yet.

### Bring-your-own IMAP passwords pass through the Worker

On the IMAP path the browser sends a mailbox password to the Worker, which forwards it over the
signed channel to the mail service. The Worker never stores, logs or decrypts it. This is a
departure from "mail passwords live in one service and nowhere else": the password is in the
Worker's memory for one request. The alternative was sealing it in the browser to a public key
of the mail service: one more key pair to run, for a path that today is self-hosting only.
Revisit before outside customers bring their own mailboxes.

## What is not exercised live

The Purelymail API does not run locally, and calls to Omni's real account need approval. The
e2e suites prove the IMAP path end to end (real Worker, real mail service, GreenMail, Postgres).
The Purelymail parsing is unit-tested in `mail-core` against fixtures (`fixtures/purelymail/`)
that follow Purelymail's published OpenAPI schema but are not recorded answers. The Purelymail
client's calls (`getOwnershipCode`, `addDomain`, `updateDomainSettings`, `listDomains`,
`listUser`, `createUser`, `createAppPassword`) have not been run against the live API. Purelymail
does not document its error codes, so the code avoids depending on them: it checks `listDomains`
and `listUser` before adding.
