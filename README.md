# Omni

One AI-first inbox for every domain we run. Purelymail stores and delivers mail; Omni reads it as
conversations, summarizes them, and sorts what needs a reply. Spec: [`docs/spec/v1.md`](docs/spec/v1.md).

## Start

```bash
pnpm install
pnpm stack:up          # Postgres + GreenMail in Docker
doppler setup -p omni -c dev
pnpm check && pnpm check-types && pnpm test:all && pnpm test:e2e
```

Agents: read [`AGENTS.md`](AGENTS.md). Decisions that differ from the spec: [`docs/adr/`](docs/adr/).

## License

Omni is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a
modified version as a network service, you must offer its source to its users. Copyright © 2026
Handlemotion.
