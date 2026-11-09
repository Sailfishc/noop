# Contributing to Remi

Technical reference for people and AI agents working on this codebase.

## Third-party pull requests

Noop accepts third-party pull requests only for:

- Bug fixes.
- Security fixes.
- Performance optimizations.

Noop was not intended to accept third-party pull requests that shape the product. Changes to product design, scheduling behavior, workflows, or product details are not accepted. New features and other changes outside the three categories above will be declined.

Keep fixes focused on the existing behavior. A bug fix, security fix, or performance optimization must not bundle unrelated product or workflow changes.

## Principles

- Self-hosted for one team: a Go server with one SQLite file, a daemon on each machine that runs agents, one NSH app.
- No personal data or secrets in this repository.
- Agents change code only through PRs on `agent/` branches; merging is a person's.

## Docs

- [docs/architecture.md](docs/architecture.md): the server, the machine daemon and the app, and the daemon's code layout.

## Development

```bash
bun install                               # also installs the pre-commit secret scan
bun test                                  # the daemon
bunx tsc --noEmit
cd server && go test -race ./...          # the server
```

End-to-end scripts against a running server are in `server/test/` (see [server/README.md](server/README.md)).
App: `cd app && nsh test` and `./build-web.sh`.

Keys, tokens, IP addresses and intranet names are refused at commit time and in CI
(`bun run secrets`); rules and how to handle a false positive: [docs/secret-scan.md](docs/secret-scan.md).

## Releasing the client apps

There is no release CI for now: the packaging workflow was removed until the apps are released again. Build the client locally with `nsh` at commit `36b91689c1e7c38379179a56381de7ddab16c6a5`.
