# Remi architecture

```
 people (app/, NSH: macOS, Linux, Windows, iOS, Android, web) ──┐
                                                               ▼
                         remi-server (server/, Go + one SQLite file, on the intranet)
                                                               ▲
 machines (src/, Bun): one daemon per computer that runs agents ┘  outbound HTTPS only
```

- People sign in with an invite link, or ask to join and an admin approves (`teamsignup.go`); then one-time codes for new devices. One server is one team (the workspace: a stable `w_…` id and a name in `kv`). Channels, threads, tasks, reminders and search
  live on the server (`server/internal/hub`, API under `/api/v1`, see `v1.go`).
- A machine joins with a one-time code (`noop join`, written into `<data>/config.local.toml`) and then only calls the
  server: it reports its runtimes, repositories and Git credentials, claims the tasks of its agents, runs them, and
  reports back. The server never connects to a machine.
- A task runs in its own worktree on an `agent/T-xxxx` branch. The machine pushes only those branches and opens PRs;
  merging is always a person's.
- Agents work with each other through the server, never directly: a handoff makes a task for the other agent, a
  delegation makes a child task whose result goes back to the delegating task (it waits, then is woken once with a
  receipt), and a question (`remi ask @agent`) is not a task at all: the other agent's machine claims it
  (`/api/v1/asks`), answers in one read-only run in a throwaway directory, and the answer reaches the asking run like a
  person's reply. Whether an agent may use another is one rule: what the task's requester could do (`teamreach.go`,
  `teamdelegate.go`, `teamask.go`).

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

`App.tsx` mounts `team/TeamApp.tsx`; it holds the frame (sign in, sidebar, panes); the screens are beside it in `app/team/`: channel and taskfacts, composer, messages, taskcard, inbox, tasks, search, reminders, settings, updates.
`app/ui/` is the shared NSH UI layer.
