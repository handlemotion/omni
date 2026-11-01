# 0003: Strip replies with mail-core's own rules, not email-reply-parser

Date: 2026-10-31 · Status: accepted

## Context

The spec (`docs/spec/v1.md`, "Cleaning each message") names email-reply-parser for stripping
quoted history and signatures. Every received message runs through it, and senders control the
text. Its quote-header patterns backtrack catastrophically: 2,000 lines of `abc. x skrev x`
(30 KB) took 19 seconds, 16 KB lines of `From: < < <` took half a second each, and runs of blank
lines or `~` grow quadratically. It runs them over the whole text, not line by line. The package
uses `re2` for linear-time matching only when that native addon is installed, and its `exports`
give no way to replace the patterns.

## Decision

`packages/mail-core/src/reply.ts` carries the library's fragment rules (bottom-up fragments,
`>` quotes, quote headers, signatures) with patterns rewritten to run on one line at a time,
each scanning its line a bounded number of times, and quote-header checks skipped for lines over
500 characters. email-reply-parser is removed.

## Why

- A message that hangs the parse step for seconds blocks the mail service's sync for every
  mailbox on that process. Untrusted input needs linear-time matching.
- `re2` is a native build: it would need build-script approval in the workspace and a toolchain
  or prebuilt download in the mail service's Docker image, for one dependency's regexes.
- The rules are small (about 120 lines) and already wrapped by our own Outlook and forward
  handling. On our fixtures and a set of localized headers the port gives the same `clean_text`.

## Consequences

- Everything in the spec that says "email-reply-parser" means `stripReply` in mail-core.
- New locales or signature formats are added to `reply.ts`, with a ReDoS case in
  `limits.test.ts` when the pattern has more than one free-form gap.
- `@omni/mail-core/clean` no longer depends on a package that fails to import on workerd; jsdom
  still keeps it Node-only.
