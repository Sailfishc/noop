# ui

Remi's own component library and the middle of its design system. Started from NSH's examples/nsh-gallery-ui
(https://github.com/longbridge/nsh), Apache License 2.0, see LICENSE-APACHE; the parts still derived from it are
popup.tsx, icons.tsx, switch.tsx, tip.tsx, spinner.tsx and scrollbar-theme.ts.

## The tiers

| Tier | Where | Who writes it | Who reads it |
|---|---|---|---|
| Source | `app/design/tokens.ts` | people, by hand: the only place a value is written | `scripts/gen-tokens.ts` |
| Semantic tokens | `app/theme.json`, `app/ui/tokens.gen.ts` | `bun scripts/gen-tokens.ts` (never by hand) | `app/ui` only |
| Components | `app/ui/*.tsx`, one per file | people | pages |
| Pages | `app/team/`, `app/App.tsx` | people | the app |

- **Colors** come from three inputs (the warm gray base, the amber attention color, the contrast), computed in OKLCH
  for light, dark and black. Roles are named by purpose: surfaces `sidebar` < `page` < `raised`, `float` (glass) and
  `floatSolid` (where blur isn't drawn), `sunken`, `field`; text `fg`, `fg2`, `fg3` (one foreground at three strengths);
  fills `hover`, `selected`, `pressed`; lines `hairline`, `edge`; `primary`/`onPrimary` (black/white); `attention`
  (amber: only what waits on you), `danger`, `ok`, `info` and their tints; `identity1..8` (agents' avatars).
  `theme.json` also carries shadcn's names (`background`, `foreground`, `popover`…) as aliases, for nsh/base.
- **Sizes** have two densities: `pointer` (desktops) and `touch` (phones, pads; text 13/15/16/17/28, controls
  36/48, rows 48/56, hit target 44). `theme.ts` picks one by device (`touch = !platform.desktop`), never by window
  width, and exports it as `size`. Boxes around text use minimum heights, so they grow with the user's text size.
  Small pressables reach the hit target through `hitSlop={slop(box)}`.
- **One scale for both**: `space` (2 4 6 8 12 16 24), `radius` (6 8 12, 14 for floating surfaces), `stroke` (0.5
  hairline…), `measure`, `opacity`.
- **Motion**: exactly six moments move, all still under reduced motion: press (`pressMotion()`), the selection
  sliding (`slider()` in Tabs and Choice), a floating surface coming in (`popIn`), a list item collapsing
  (`collapseNext()`), the accept check drawing in (`DoneMark`), and a working agent's dot breathing (`Dot breathe`).
  Plus a spinner and state fades. No sound.
- **Depth**: only floating surfaces (menus, popovers, tooltips, toasts, dialogs) cast shadows: `floatSurface()` is
  glass, a hairline, three faint shadow layers, radius 14, opaque on Linux.

## The checks

- `bun scripts/gen-tokens.ts --check`: the generated files are exactly what the source makes, and contrast holds.
- `bun scripts/check-ui.ts`: zero raw values in `app/ui` (data files exempt by name: icons, the QR code and scanner,
  jsQR, the scrollbar's class config, the generated file); pages' debt only goes down; no unused token.
- `nsh check app`: an unknown token is a type error (every read goes through typed objects).
- `scripts/check-layout.ts`: 44-point hit targets on phone screens.
- `scripts/screens.sh`: the showcase (`showcase.tsx`) in light and dark, desktop and phone, and its Tokens tab
  (`showcase-tokens.tsx`), which lists every token from the generated file.

## Adding things

A new value: add it to `app/design/tokens.ts`, run `bun scripts/gen-tokens.ts`, read it in a component. A new
component or variant: a file here, an export in `index.ts`, an entry in the showcase. Pages import from `../ui` only.
