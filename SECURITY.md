# Security policy

Omni holds a password for every mailbox it connects to, so a security bug can expose someone's
email. We take reports seriously and thank everyone who sends one.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** ([direct link](https://github.com/handlemotion/omni/security/advisories/new)).
Please do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include what you can: the affected component and commit, steps to reproduce or a proof of
concept, and the impact you expect. We aim to acknowledge a report within 3 business days and to
agree a disclosure date with you once a fix is ready. We credit reporters in the advisory unless
you ask us not to.

Test only against your own self-hosted instance or the local stack (`pnpm stack:up`). Do not
access other people's mail or data, degrade hosted Omni, or run automated scans against it.

## Scope

In scope is the code in this repository, especially:

- **Mailbox credential handling.** App passwords are encrypted with AES-256-GCM before they reach
  Postgres, and only the mail service (`apps/mail`) holds the key. Anything that lets the Worker,
  a client, logs, or the database reveal a plaintext credential or the key is in scope.
- **Worker ↔ mail service signing.** Requests between them are HMAC-signed with a timestamp and
  rejected outside a short window. Forgery, replay, or bypassing verification is in scope.
- **HTML sanitizing.** Message HTML is sanitized with DOMPurify when it is saved and rendered with
  scripts off. Script execution, sanitizer bypasses, or content escaping its frame is in scope.
- **Image proxy.** Remote images load through our proxy so senders never see a reader's IP.
  IP leaks, server-side request forgery, or using the proxy as an open relay is in scope.
- Authentication and authorization (Better Auth sessions, passkeys, magic links), and any way to
  read mail across members or organizations (`db.forMember`).

Out of scope: vulnerabilities in Purelymail, Cloudflare, Fly.io, or PlanetScale themselves
(report those to the vendor), findings that need a compromised device or host, missing hardening
headers without a demonstrated impact, and denial of service by volume.

## Supported versions

Omni has no tagged releases yet. Security fixes land on `main` and ship from there; hosted Omni
runs `main`. If you self-host, run the latest `main`. Once we tag releases, this section will list
which ones receive fixes.
