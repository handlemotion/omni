# Purelymail reselling is still an open question while hosted mailboxes are sold

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Business                                     |
| Who      | Rodrigo                                      |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `docs/spec/v1.md:291,340`

## Problem

The spec says to offer hosted mailboxes only if Purelymail allows reselling, and keeps it as an unchecked question. Self-serve sign-up, the paid plan, and Omni-hosted domains and mailboxes are live. No ADR records an answer.

## Evidence

Docs and ADRs searched.

## Fix

Get Purelymail's answer in writing and record it as an ADR, or gate hosted provisioning.

## Done when

An ADR exists.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
