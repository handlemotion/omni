# Mailbox provisioning lets a member probe the mail service's internal network

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Security (apps/mail, contracts)              |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `packages/contracts/src/index.ts:311-315` (`serverSchema`: any host, any port)
- `apps/worker/src/provision-mailbox.ts:14-17`
- `apps/mail/src/verify-login.ts:172-175`

## Problem

A member with a verified domain can point IMAP/SMTP settings at `localhost`, `*.internal`, 10.x or `fdaa::` hosts on any port. The verify step returns `IMAP login to ${host} failed: ${responseText ?? error.message}`, which reflects raw socket errors and banners back.

## Evidence

Read from the code; not exploited.

## Fix

In the mail service, resolve the host and refuse loopback, private, link-local and ULA addresses (including Fly's `fdaa::/16` and `.internal`) unless an env flag allows them (needed for the local stack). Return a generic message for network errors; keep `responseText` only for real IMAP `NO`/`BAD` replies. The Worker's image proxy already does a similar private-address check (`IMAGE_PROXY_DOH_URL`) worth reusing in spirit.

## Done when

An e2e case: provisioning with `127.0.0.1:5432` is refused with a generic error.

## Notes

Security fix: keep details out of the public PR.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
