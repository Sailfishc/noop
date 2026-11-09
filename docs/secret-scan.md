# Secret scan

Keys, tokens, server addresses and intranet names must not reach the repository. They
belong in local config (`config.local.toml`, `~/.noop/…`), environment variables, CI
secrets, or what the user types at runtime. A server address in `app/nsh.json` (for
example an ATS `NSExceptionDomains` entry for one company's server) is the typical case:
it leaks the address and only works for that one deployment.

One script, `scripts/check-secrets.ts`, enforces this in two places:

| Where | Command | What it scans |
|---|---|---|
| `git commit` (pre-commit hook) | `bun scripts/check-secrets.ts --staged` | lines added in the staged change |
| CI job `secrets` | `--range BASE..HEAD`, then no flag | every commit the push or PR adds, then the whole tree |
| By hand | `bun run secrets` | the whole tree |

`bun install` installs the hook (`prepare` sets `core.hooksPath` to `.githooks`).
The CI range scan looks at each commit, so a secret added in one commit and deleted
in the next still fails: it is in the history.

## Rules

| Rule | Refuses |
|---|---|
| `private-key` | `-----BEGIN … PRIVATE KEY-----` |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
| `gitlab-token` | `glpat-` |
| `slack-token` | `xoxb-`, `xoxp-`, … |
| `aws-key` | `AKIA…`, `ASIA…` |
| `google-key` | `AIza…` |
| `llm-key` | `sk-…`, `sk-ant-…`, `sk-proj-…` (32+ characters) |
| `jwt` | `eyJ….eyJ….…` |
| `url-credentials` | `scheme://user:password@host` |
| `assigned-secret` | a 16+ character literal with letters and digits assigned to a `password`, `secret`, `token`, `api_key`, `access_key` or `private_key` field |
| `ip-address` | any IPv4 address, private or public |
| `local-pattern` | your own patterns (below) |

Allowed without any marker:

- addresses `127.x.x.x`, `0.0.0.0`, `255.255.255.255`, and the documentation ranges
  `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (RFC 5737). Use these in tests,
  docs and examples, e.g. `http://192.0.2.5:8080`.
- placeholders: values containing `${…}`, `$VAR`, `<…>`, `…`, `xxxx`, `example`,
  `your-`, `changeme`, `dummy`, `fake`; URL passwords `pass`, `password`, `secret`, `token`.
- SVG path data, version numbers, `bun.lock`, `go.sum` and binary files.

## Intranet domains and other names

The rule list cannot name your company's intranet domains, because the list itself
is in the repository. Add them outside it, one regex per line:

- locally: `.git/info/sensitive-patterns` (per clone, never committed);
- in CI: the repository secret `REMI_SENSITIVE_PATTERNS` (Settings → Secrets and
  variables → Actions). The job reads it if it exists.

```
# .git/info/sensitive-patterns
\bcorp-intra\.example\b
\binternal-git\.example\b
```

## A hit that is not a secret

1. Prefer changing the value: a documentation IP instead of a real one, a placeholder
   instead of a real-looking token.
2. For one reviewed line, add a comment on that line:
   `secret-scan: allow <reason>`.
3. For a whole file that cannot carry comments (vendored, generated), add
   `<rule-id|*> <path-glob>` to `.secretscan-allow`, with the reason in a comment above.

`git commit --no-verify` skips the hook once, but CI runs the same scan.

## A real secret that got committed

Rotate it first. Deleting it from the branch, or even rewriting history, does not help
once it was pushed: forks, clones and caches keep it.

## Limits

These are pattern checks: they catch known token formats and literal addresses, not a
secret that has no recognisable shape. IPv6 addresses and hostnames are not checked
unless you add them as local patterns.
