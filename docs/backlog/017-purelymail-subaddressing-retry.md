# Turning off Purelymail symbolic subaddressing is never retried after a failure

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Mail hosting (apps/mail)                     |
| Who      | Agent, but confirm with Rodrigo              |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/mail/src/hosting/purelymail-host.ts:39-56`

## Problem

Right after `addDomain`, `setSymbolicSubaddressing(name, false)` runs inside `call()`, which wraps any error as `MailHostError`. The outer catch only handles `PurelymailError`, so the member sees "Purelymail is unreachable", and the next call takes the `recheckDns` branch because the domain is now added. Subaddressing stays on, and `purelymailUsernameProblem` refuses every `first.last` mailbox with a 422.

## Evidence

Verified by reading the code.

## Fix

Move the call out of the `addDomain` try block, and when `state.added && state.symbolicSubaddressing` turn it off. Caution: a domain that was on the Purelymail account before Omni may rely on subaddressing, so only turn it off for domains Omni added (e.g. record that on the domain row), or ask Rodrigo first.

## Done when

Hard to e2e (Purelymail is external); describe the manual check in the PR.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
