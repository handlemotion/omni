---
name: steward
description: How to handle review findings and CI on a pull request you own or watch in this repo. Use whenever a review comment, bot finding or CI result arrives on a PR, before deciding whether to push.
---

# Steward

Conventions for driving a pull request to mergeable in Omni. They override the default pacing an
agent harness gives for PR activity.

## Review findings: fix and push now

- Verify every finding against the code first (reproduce it, or trace it). A finding that isn't
  real gets a reply saying what you traced; nothing else.
- A verified finding gets fixed and **pushed right away, whatever its label**. "Optional", P2,
  P3, nit, minor, low, info, a yellow or purple badge: none of these is a reason to hold a fix
  for a later push. Never sit on a committed, verified fix waiting for "the next push".
- Several findings that arrive together go in one push. Don't wait for findings that haven't
  arrived.
- After pushing, reply on each thread with the commit and the evidence, then resolve the thread.

## Before each push

Run what `AGENTS.md` asks ("Branching and shipping"): `pnpm check`, `pnpm check-types`, and the
tests and e2e files the change touches.
