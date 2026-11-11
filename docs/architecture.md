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
- Work survives a computer or a runtime going away, but never moves on its own. The machine saves a checkpoint
  (`src/checkpoint.ts`, `teamcheckpoint.go`) every 10 minutes while a run changes things and whenever it stops: for a
  repository, one commit of the whole worktree made with a temporary index and pushed to `agent/T-xxxx-wip` (the
  agent's own index and branch untouched); otherwise the packed directory, stored on the server. The server keeps
  only the latest. When the task's computer has been offline 10 minutes, or its runtime is held back there (a usage
  limit far off, no credit, logged out) while another can take it, the agent's owner gets a card (`teammove.go`,
  `teamengine.go`). A move gives the task to the other computer and bumps `tasks_v1.moves`: every run-scoped call
  carries `?moves=`, so a run on the old computer that comes back is refused and pushes nothing. The new computer
  restores the checkpoint and starts a fresh session from the thread. A runtime switch sets `tasks_v1.runtime` for
  that task only: same computer, same directory, fresh session, that runtime's default model.
- Standing duties are triggers, not a new object (`teamtriggers.go`, `teamduties.go`, `teamchecks.go`,
  `teamproposals.go`). Triggers of one channel, agent and duty name are one group with a history (`trigger_runs`, 100
  lines each). A read-only trigger's task (`tasks_v1.readonly`) may not open a PR, hand off or delegate; its first
  message waits in `tasks_v1.held` and is posted only when something is first said in its thread, so a run that ends
  with `nothing` leaves no message, no unread and no inbox item. A schedule with a check command first hands the
  agent's computer a check (socket frame or the machine poll's `checks`, never a task); the daemon runs it for 60 s
  with the agents' git limits and posts the output's hash: the same hash records "no change", a new one (or an error)
  fires the trigger with the output. Only the agent's owner confirms a check command, by the exact text they saw. An
  agent's `remi propose` stores a proposal for the person the run is for; `tickProposals` puts what came in before
  that person's time (`users.digest`, the server's time zone) onto one card (`proposal_batches`), urgent ones alone
  outside quiet hours. 做 makes a normal task in their name with the plan as its acceptance, already aligned.

## Daemon layout (`src/`)

| Path | What |
|---|---|
| `cli.ts` | `noop join / install / daemon / doctor / update` |
| `config.ts` | where things live (`$NOOP_HOME`, else `~/.noop`; data in `$HUB_DATA`, else `<home>/data`) and the config |
| `teamagent.ts` | the connection to the server: the machine report, the message stream, runtime and Git detection |
| `teamwork.ts` | the worker: claim, prepare the workdir (restoring a checkpoint after a move), run, report (with an outbox), the `remi` command agents use |
| `checkpoint.ts` | checkpoints: the wip commit or the packed directory, saved while a run goes and when it stops |
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
