# Domain Connect templates

[Domain Connect](https://www.domainconnect.org) lets a DNS host add a service's records in one
click. Omni offers "Set up automatically" on the DNS page only when the domain's DNS host serves
the standard (a `_domainconnect` TXT on the zone) **and** has onboarded our template. Otherwise
the page shows the records to add by hand, with the host's own steps when it is one we know
(ADR 0011).

| Template      | Used for                                        | Variables                |
| ------------- | ----------------------------------------------- | ------------------------ |
| `mail.json`   | Purelymail domains: challenge plus mail records | `challenge`, `ownership` |
| `verify.json` | Domains that stay on their own mail host        | `challenge`              |

Each TXT value keeps its fixed prefix in the template (`omni-challenge=`,
`purelymail_ownership_proof=`); the Worker sends only the part after it, as the registry requires.
The SPF record is `SPFM`, so the DNS host merges our include into an SPF record that already
exists instead of adding a second one.

## Publishing (self-hosters do the same under their own domain)

1. Replace `omnidirectional.app` (hosted Omni's) in `providerId`, `syncPubKeyDomain`,
   `syncRedirectDomain` and `logoUrl` with your own domain. `syncRedirectDomain` must be your web app's domain: the host sends the
   member back to `<WEB_APP_URL>/onboarding`.
2. Make a signing key pair. Publish the public key as TXT records under `syncPubKeyDomain`, as
   the [spec](https://github.com/Domain-Connect/spec/blob/master/Domain%20Connect%20Spec%20Draft.adoc)
   describes, and note the host you used (for example `_dck1`).
3. Open a pull request with both files at
   [Domain-Connect/Templates](https://github.com/Domain-Connect/Templates), named
   `<providerId>.<serviceId>.json`. Each DNS host (Cloudflare, GoDaddy, ...) then onboards
   templates on its own schedule. Cloudflare answers `404 unknown template` until it has.
4. Set on the Worker: `DOMAIN_CONNECT_PROVIDER_ID` (your `providerId`), `DOMAIN_CONNECT_KEY_HOST`
   (the key's TXT host; hosted Omni uses `_dck1`) and the secret `DOMAIN_CONNECT_PRIVATE_KEY` (PKCS#8 PEM). With
   `DOMAIN_CONNECT_PROVIDER_ID` empty the button never shows.

Check a template before submitting it with the registry's linter:
`dc-template-linter -merge-or-fail <providerId>.<serviceId>.json` (exit 0 is the fast track).
