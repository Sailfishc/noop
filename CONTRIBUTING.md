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

Push a tag `vX.Y.Z`: `.github/workflows/release.yml` packages macOS (Apple silicon) and Linux, signs an OTA package and the update manifest, and publishes the latest GitHub release that installed apps update from. One-time key setup (`scripts/release-keys.sh`) and how updates work: [docs/app-updates.md](docs/app-updates.md). To build the client locally, use `nsh` at the commit in `app/nsh-version`; a local build does not update itself.
