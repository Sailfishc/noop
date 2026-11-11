# Working in this repository

Remi: a self-hosted place where a team's people and agents work together. Three parts in one repository
(map and data flow: [docs/architecture.md](docs/architecture.md); commands: [CONTRIBUTING.md](CONTRIBUTING.md)):

| Part | Where | Language | Checked by |
|---|---|---|---|
| Server | `server/` (API in `internal/hub/v1.go`) | Go, one SQLite file | `gofmt`, `go vet`, `go test -race` |
| Machine daemon | `src/` (tests in `test/`) | Bun / TypeScript | `bunx tsc --noEmit`, `bun test` |
| Client app | `app/` (`team/` screens, `ui/` components) | NSH TSX | `nsh check app`, `nsh test`, layout, `check-ui`, screenshots |
| Both ends together | `server/test/e2e-*.ts` | Bun against a real server | `scripts/e2e.sh` |

## How to work here

1. This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.
2. Before you start, say in a line what you're about to do; brief updates while you work help the user follow along.
   Close with a short recap that stands on its own (what you found, what you did, and what's next), so a reader who
   only sees the last message has the full picture.

## Before you push: `scripts/check.sh`

It runs what CI runs for the parts your change touches (compared with `origin/main`) and prints one summary;
`scripts/check.sh all` runs everything (about 3 minutes), `scripts/check.sh app server` runs those parts.
Fix what it reports. Put what it lists as NOT RUN in the PR.

- `nsh`: cloud sessions get it from `.claude/hooks/session-start.sh`, but that hook only runs when the session
  starts inside this repository. If `nsh` is missing, `scripts/check.sh` installs it, or run
  `export PATH="$(scripts/install-nsh.sh):$PATH"` (Linux x86_64, about 30 s).
- Many sessions branch from `main` at once. Before you push, `git fetch origin main` and rebase or merge, and
  look at main's last CI run: if main is already red, say so instead of chasing a failure you did not cause.

## Trying a change end to end: `scripts/dev.sh`

Tests use a pretend server (`app/fixtures.ts`, kept honest by `scripts/check-contract.ts`). To see the real thing,
`scripts/dev.sh` starts remi-server with the web client, seeds a small team (张伟 admin, 王磊, agents @acha with
an orders repo on both of 张伟's two machines and @notes, #支付后端) and runs this repository's daemon as those machines, with
`scripts/fake-codex.ts` as Codex: no model, no keys. Everything lives in `.dev/`; `--fresh` starts over.

- It prints login links and a curl line. Run it in the background, then drive it through the API
  (`.dev/state.json` holds the sessions) and look with `node scripts/dev-shot.cjs [--as wl] [--size 390x844]
  [--click x,y] out.png`, a screenshot of the web client signed in against the real server.
- In a request, `[align]`, `[decide]`, `[block]`, `[fail]` and `[slow]` make the fake Codex align first, ask, get stuck, fail or take
  its time; otherwise it commits a file (repository task) or writes `out/notes.md` (general task) and reports review.
  `[quota]` makes it hit its usage limit (`FAKE_CODEX_QUOTA_MIN` minutes away); the machines also have the same fake as
  `claude`, which never does, so a long limit brings up the 换引擎继续 card. `dev-shot.cjs --lang zh` shoots in Chinese.

## Workflow for Small Fixes

For small fixes with clear scope and acceptance criteria, make the change directly and verify it. Do not create design documents, specs, implementation plans, or extra approval checkpoints. Use a full design and planning workflow only when the change affects architecture or public APIs, spans multiple subsystems, or has materially ambiguous requirements.

## Client (`app/`) changes

The client is NSH TSX. Before writing it, read the NSH skill (`.claude/skills/nsh`, vendored at the pinned commit) and NSH's docs for the components you touch: NSH is not React Native or the web, and props that look familiar can behave differently. Example: a horizontal `Scroll` needs one row `View` as its child, or its children stack (the task board shipped like that in #41).

After changing `app/`, `scripts/check.sh` runs these; what each one is for:

- `nsh check app`: the real type check (the root `bunx tsc` does not cover `app/`).
- `cd app && nsh test`: the UI tests, including `screens.test.tsx`.
- `scripts/screens.sh`, then open the PNGs in `app/.nsh/screens/` and look at the screens you changed. Add a screen to `app/screens.test.tsx` when you build a new one.
- Layout a test can't see (things side by side, aligned, not overlapping): add a rule to `scripts/check-layout.ts`; run it with `(cd app && nsh test screens.test.tsx --trace) > /tmp/trace.txt; bun scripts/check-layout.ts /tmp/trace.txt`.
- `bun scripts/check-ui.ts`: pages don't style themselves (see "Client components" below).

In the PR, say which screens changed, attach or describe the screenshots you looked at, and list anything you could not run.

### Client components: pages use `app/ui`, only `app/ui` decides the look

Four layers, each using only the one below: pages (`app/team/`: layout and logic) → Remi's component library
(`app/ui/`, one component per file) → `nsh/base` and `nsh` → the theme (`app/theme.json`: colors and the scales:
text 12/13/14/16/22, radius 6/8/12, spacing 2/4/6/8/12/16/24, control height 30/40; `scale` in `app/ui/theme.ts`).

1. Before building or changing a screen, look at the component showcase (`showcase-light.png` / `showcase-dark.png`
   from `scripts/screens.sh`, source `app/ui/showcase.tsx`) to see what exists.
2. Pages only use `app/ui`: no font sizes, radii, color values, off-scale spacing, `nsh/base` imports or Views made
   pressable with `role="button"` in `app/team/`. A component takes a few named variants (`kind`, `size`), not
   arbitrary styles.
3. Missing something? Add it (or a variant) to `app/ui` first, with an entry in the showcase, then use it.
4. Any task that adds a page or touches an old one switches the parts it touches to `app/ui` components instead of
   hand-written styles. There is no separate clean-up pass: old pages get paid down this way.

`scripts/check-ui.ts` enforces 2: `scripts/ui-baseline.json` holds the old pages' debt per file. A count above it
fails; a count below it fails until you lock the lower number in with `bun scripts/check-ui.ts --update`. Never raise
the baseline by hand. NSH's `nsh/base` gives behavior (focus, keyboard, dismissal, accessibility) and no look:
`app/ui` wraps each one once. Check a base component exists at the pinned NSH (`app/.nsh/types/nsh/base.d.ts` after
`nsh check app`) before wrapping it. New icons: take the path from Lucide (ISC) into `app/ui/icons.tsx`.

### Explanations go behind an ⓘ, not under the label

Bad case, repeated (settings pages before #63's fix, then the private channel screens in #69): a label or control
with a sentence or two of explanation printed under it. A few of those and the screen reads as paragraphs.

- A label or control keeps one short line. Why it exists, what it means, what happens later: put it in the `note`
  of `Noted` (or `Label` / `Panel`, which take a `note`) in `app/ui`. It shows a small ⓘ that opens the
  note on press, the same on a phone.
- An empty state is a word ("没有"), with the explanation in the section label's ⓘ.
- A disabled row says why in its ⓘ, not in a second line.
- Text stays on screen only where the person must read it before acting: a confirm step before something that can't
  be undone or that sends data elsewhere. Keep that to one sentence.
- When you look at screenshots, count the lines of grey text: more than one under any label is this bad case.

## Changing the client without running it

Only if `nsh` really can't be installed (`scripts/install-nsh.sh` failed, or a platform it has no build for), client changes are unverified until someone opens the app. Then:

- Use only nsh components and props that already work elsewhere in `app/`. A prop that appears nowhere else is unproven: `<Scroll horizontal>` stacked a task board's columns vertically on the Mac (fixed in #43). For side-by-side layout, put a `flexDirection: "row"` View inside a plain Scroll.
- Say in the PR which screens changed and that they were not run, so the person checks those screens before merging.

## Update the app on the user's iPhone (local Mac sessions only)

When asked to update Noop on the user's iPhone, build the current working-tree app, install it over Wi-Fi, and verify that it launches. The paired iPhone is `00008150-001603543C08401C`; the app bundle ID is `dev.noop.app`. Use `xcrun devicectl list devices` and device details to check connectivity.

The existing device build is `app/.nsh/out/noop.app`. Its embedded provisioning profile and signing authority identify the correct signing configuration: inspect the app with `codesign -dvv` and match its `Authority` to an identity from `security find-identity -v -p codesigning`. Do not assume the first certificate in the provisioning profile is the right identity. On 2026-11-02 the working identity was `Apple Development: Huashun Li (MJMFDP85B6)`, fingerprint `23A880371F9BA289EA15125ED6473F4C73F90BD6`.

Prefer `nsh package app --target ios --sign <identity> --profile <profile>` when the iOS runtime can be built. Copy the embedded profile to a temporary location first so it survives replacement of the output app. If the runtime build is blocked, the following workflow was verified with the existing runtime: `nsh build app --release -o <temporary-bundle>`, copy the existing app to a temporary `.app`, replace its `nsh/bundle.nshc`, `nsh/app.json`, and `nsh/capabilities.json` with the freshly built files, then sign the copy using the existing `app/.nsh/out/noop.entitlements`. This fallback reuses the existing native runtime; if native runtime changes are needed, build a fresh package instead.

Verify the signature with `codesign --verify --strict`, install with `xcrun devicectl device install app --device 00008150-001603543C08401C <app-path>`, then launch with `xcrun devicectl device process launch --device 00008150-001603543C08401C dev.noop.app`. Preserve the bundle ID so the installation updates the existing app and retains its data. Report any build, signing, connection, or launch failure accurately.
