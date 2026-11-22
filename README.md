# Omni

One AI-first inbox, plus Drive and a CRM, over the mail you already have. Omni reads any
IMAP/SMTP mailbox (Purelymail, Fastmail, Google Workspace, your own server) as conversations,
sorts what needs a reply, and keeps a team's mail, files and clients in one place. It runs on the
web, macOS, Windows and iPhone, and you can host it yourself.

## Run it locally

You need Node 26 (`.nvmrc`), pnpm and Docker.

```bash
pnpm install
pnpm stack:up     # Postgres, GreenMail (IMAP/SMTP), an S3-compatible store and s2-lite
pnpm dev:stack    # migrates, seeds, and serves the app at http://localhost:5173
```

Sign in as `dev@example.com`. The seed connects two mailboxes on the local GreenMail server.

## Layout

| Path                   | What it is                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| `apps/worker`          | The API, on Cloudflare Workers                                            |
| `apps/mail`            | The mail service: the only part that speaks IMAP/SMTP and holds passwords |
| `apps/web`             | The web app                                                               |
| `apps/desktop`         | The macOS and Windows apps (Tauri), with Drive sync on macOS              |
| `apps/ios`             | The iPhone app (Expo)                                                     |
| `packages/*`           | Shared code: database, contracts, auth, crypto, mail parsing, AI          |
| `docs/spec`            | The product spec                                                          |
| `docs/self-hosting.md` | How to run your own Omni                                                  |

## Icons

The web and iOS apps use [Central Icons](https://centralicons.com), a commercial icon set
installed from npm. Using them in your own build needs your own Central licence.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Report vulnerabilities privately, as
[`SECURITY.md`](SECURITY.md) describes.

## License

Omni is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a
modified version as a network service, you must offer its source to its users. Copyright © 2026
Handlemotion.
