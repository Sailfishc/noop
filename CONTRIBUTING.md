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
bun install
bun test                                  # the daemon
bunx tsc --noEmit
cd server && go test -race ./...          # the server
```

End-to-end scripts against a running server are in `server/test/` (see [server/README.md](server/README.md)).
App: `cd app && nsh test` and `./build-web.sh`.

## Releasing the client apps

Push a tag `vX.Y.Z`. [release.yml](.github/workflows/release.yml) packages Linux, Windows, macOS, iOS, Android and the web client and publishes them as a GitHub release; pull requests that change the workflow or the installers build them without publishing. The tag sets the app version and the run number sets the build number.

The release also carries `latest.json` and versioned archives (`Noop-<version>-<os>-<arch>`): installed desktop apps update from them through `nsh/updater`, and the Android app gets a link to the APK. Keep the unversioned assets too, the installers use them.

The workflow builds nsh from the commit in `NSH_REF` and caches it; a commit not yet cached takes a while on each runner. Android signing uses the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS` and `ANDROID_KEYSTORE_PASSWORD`. Keep that key: Android refuses an update signed with another one. The iOS package is unsigned.

Do not run tests against a production server or a live data directory.
