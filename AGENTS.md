## Workflow for Small Fixes

For small fixes with clear scope and acceptance criteria, make the change directly and verify it. Do not create design documents, specs, implementation plans, or extra approval checkpoints. Use a full design and planning workflow only when the change affects architecture or public APIs, spans multiple subsystems, or has materially ambiguous requirements.

## Client (`app/`) changes

The client is NSH TSX. Before writing it, read the NSH skill (`.claude/skills/nsh`, vendored at the pinned commit) and NSH's docs for the components you touch: NSH is not React Native or the web, and props that look familiar can behave differently. Example: a horizontal `Scroll` needs one row `View` as its child, or its children stack (the task board shipped like that in #41).

After changing `app/`, run these and fix what they report before opening a PR. Cloud sessions get `nsh` from `.claude/hooks/session-start.sh`; CI runs the same steps.

- `nsh check app`: the real type check (the root `bunx tsc` does not cover `app/`).
- `cd app && nsh test`: the UI tests, including `screens.test.tsx`.
- `scripts/screens.sh`, then open the PNGs in `app/.nsh/screens/` and look at the screens you changed. Add a screen to `app/screens.test.tsx` when you build a new one.
- Layout a test can't see (things side by side, aligned, not overlapping): add a rule to `scripts/check-layout.ts`; run it with `(cd app && nsh test screens.test.tsx --trace) > /tmp/trace.txt; bun scripts/check-layout.ts /tmp/trace.txt`.

In the PR, say which screens changed, attach or describe the screenshots you looked at, and list anything you could not run.

## Update Noop on the user's iPhone

When asked to update Noop on the user's iPhone, build the current working-tree app, install it over Wi-Fi, and verify that it launches. The paired iPhone is `00008150-001603543C08401C`; the app bundle ID is `dev.noop.app`. Use `xcrun devicectl list devices` and device details to check connectivity.

The existing device build is `app/.nsh/out/noop.app`. Its embedded provisioning profile and signing authority identify the correct signing configuration: inspect the app with `codesign -dvv` and match its `Authority` to an identity from `security find-identity -v -p codesigning`. Do not assume the first certificate in the provisioning profile is the right identity. On 2026-11-02 the working identity was `Apple Development: Huashun Li (MJMFDP85B6)`, fingerprint `23A880371F9BA289EA15125ED6473F4C73F90BD6`.

Prefer `nsh package app --target ios --sign <identity> --profile <profile>` when the iOS runtime can be built. Copy the embedded profile to a temporary location first so it survives replacement of the output app. If the runtime build is blocked, the following workflow was verified with the existing runtime: `nsh build app --release -o <temporary-bundle>`, copy the existing app to a temporary `.app`, replace its `nsh/bundle.nshc`, `nsh/app.json`, and `nsh/capabilities.json` with the freshly built files, then sign the copy using the existing `app/.nsh/out/noop.entitlements`. This fallback reuses the existing native runtime; if native runtime changes are needed, build a fresh package instead.

Verify the signature with `codesign --verify --strict`, install with `xcrun devicectl device install app --device 00008150-001603543C08401C <app-path>`, then launch with `xcrun devicectl device process launch --device 00008150-001603543C08401C dev.noop.app`. Preserve the bundle ID so the installation updates the existing app and retains its data. Report any build, signing, connection, or launch failure accurately.
