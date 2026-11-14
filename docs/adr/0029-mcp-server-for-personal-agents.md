# 0029: An MCP server for people's own agents

Date: 2026-11-14 · Status: accepted · Amends: spec v1 ("Non-goals": "ask your inbox"; "Safety
and cost": the model has no tools), ADR 0005 (revisit when direct SQL access arrives)

## Context

People want their own agents (Claude, ChatGPT) to answer questions from their mail and to
triage it. The v1 spec put "ask your inbox" in v2 and said the model "has no tools and cannot
act". That rule was written for our triage model, and it still holds for it. A person's own
agent is a different client: it acts for them, with their permission. The full design is in
`docs/spec/mcp.md`.

## Decision

1. **Omni serves MCP at `<BETTER_AUTH_URL>/mcp`** from the existing Worker. The tools are
   `inbox`, `search`, `fetch`, `query`, `triage` and `draft_reply`. They call the same `@omni/db`
   reads and the same writers the routes use. Nothing sends mail.
2. **OAuth 2.1 only, with Omni as the authorization server** (Better Auth's `mcp`, `cimd` and
   `jwt` plugins). Scopes are `mail:read`, `mail:triage` and `mail:draft`. Access tokens are JWTs
   bound to the `/mcp` resource. A grant covers every workspace (the default) or one, and a
   session scoped to a company (ADR 0024) can grant only that company.
3. **Client registration uses Client ID Metadata Documents (CIMD), fetched only from allowlisted
   hosts** (`MCP_CIMD_HOSTS`, default `claude.ai` and `chatgpt.com`), plus Dynamic Client
   Registration for every other client. A Worker cannot pin the address it resolves, so fetching
   arbitrary metadata URLs would open server-side request forgery.
4. **`query` gets database-level isolation of its own, not row-level security on the app's
   tables.** It connects as an `omni_agent` role that can read only `security_barrier` views in an
   `agent` schema. The views apply the same grant check as `forUser`, to grantees recorded by a
   `SECURITY DEFINER` function that checks an HMAC the role cannot forge. Full-text search runs
   inside a definer function, so the GIN index stays usable (ADR 0005's finding). The tool is
   optional: without `AGENT_DATABASE_URL` it is not listed.

## Why

- Tools that reuse the app's read paths cannot see more than the app, and keep its leak tests
  meaningful.
- ChatGPT accepts no API keys, and Claude has them only in a limited beta. OAuth is what both
  clients support.
- ADR 0005 named direct SQL access as the moment to add database-level isolation. Scoping that
  isolation to one read-only role keeps app queries and search as fast as they are now.

## Consequences

- Better Auth moves to 1.7.23, and sessions are stored in the database. The OAuth and JWKS
  tables arrive through `auth:generate`, all additive.
- Self-hosters get one optional step: creating the `omni_agent` role and its connection string.
- Mail text now reaches an agent that has tools. The tools cannot send, delete or administer. A
  hijacked agent can only misfile or archive mail, which is reversible and audited.
