# Remi architecture

```
 people (app/, NSH: macOS, Linux, Windows, iOS, Android, web) ──┐
                                                               ▼
                         remi-server (server/, Go + one SQLite file, on the intranet)
                                                               ▲
 machines (src/, Bun): one daemon per computer that runs agents ┘  outbound HTTPS only
```

- People sign in with an invite link, then one-time codes for new devices. Channels, threads, tasks, reminders and search
  live on the server (`server/internal/hub`, API under `/api/v1`, see `v1.go`).
- A machine joins with a one-time code (`noop join`, written into `<data>/config.local.toml`) and then only calls the
  server: it reports its runtimes, repositories and Git credentials, claims the tasks of its agents, runs them, and
  reports back. The server never connects to a machine.
- A task runs in its own worktree on an `agent/T-xxxx` branch. The machine pushes only those branches and opens PRs;
  merging is always a person's.

## Daemon layout (`src/`)

| Path | What |
|---|---|
| `cli.ts` | `noop join / install / daemon / doctor / update` |
| `config.ts` | where things live (`$NOOP_HOME`, else `~/.noop`; data in `$HUB_DATA`, else `<home>/data`) and the config |
| `teamagent.ts` | the connection to the server: the machine report, the message stream, runtime and Git detection |
| `teamwork.ts` | the worker: claim, prepare the workdir, run, report (with an outbox), the `remi` command agents use |
| `runtimes.ts` | Codex, Claude Code and Pi: their commands and JSONL events; the watchdog and process groups |
| `runfail.ts` | what a failed run means and what to do next (retry, fresh session, continue, block) |
| `gitflow.ts`, `repos.ts` | branches, PRs and CI on GitHub and GitLab-based platforms; finding and cloning repositories |
| `gates.ts`, `github.ts` | commands an agent may not run (merge, release, force-push, …) |
| `join.ts`, `setup.ts` | joining a server; the service (systemd, launchd, Scheduled Task) and self-update with rollback |

The daemon follows this repository's `main`: when `origin/main` moves and no task runs, it fast-forwards, runs
`bun test`, and rolls back if they fail.

## Client (`app/`)

`App.tsx` mounts `team/TeamApp.tsx`; the screens are in `app/team/` (settings, tasks, search, reminders, updates).
`app/ui/` is the shared NSH UI layer.
