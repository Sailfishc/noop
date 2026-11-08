#!/usr/bin/env bash
# TeamAgent: connect this computer to a TeamAgent server as a machine, in one line.
# The app (设置 → 我的机器 → 添加机器) gives the exact command:
#   curl -fsSL <server>/api/v1/install.sh | bash -s -- <server> <join code>
# It installs Bun if missing, the daemon (into ~/.noop/app), trades the one-time join code for this machine's
# token, and runs the daemon as a background service (launchd on macOS, systemd --user on Linux).
set -euo pipefail

SERVER="${1:-}"; CODE="${2:-}"
if [ -z "$SERVER" ] || [ -z "$CODE" ]; then
  echo "用法：curl -fsSL <服务端>/api/v1/install.sh | bash -s -- <服务端地址> <接入码>"; exit 1
fi
HOME_DIR="${NOOP_HOME:-$HOME/.noop}"
APP="$HOME_DIR/app"
REPO="${TEAMAGENT_REPO:-https://github.com/Sailfishc/noop.git}"
LOG="$HOME_DIR/install.log"
mkdir -p "$HOME_DIR" && : > "$LOG"

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= D= G= Y= R= N=; fi
step() { printf "  %s%-22s%s" "$D" "$1" "$N"; }
ok()   { printf "%s✓%s %s\n" "$G" "$N" "${1:-}"; }
warn() { printf "%s!%s %s\n" "$Y" "$N" "$1"; }
fail() { printf "%s✗%s %s\n" "$R" "$N" "$1"; exit 1; }
run()  { "$@" >>"$LOG" 2>&1; }
trap 'printf "\n%s✗%s 安装没有完成，详细输出在 %s\n" "$R" "$N" "$LOG"' ERR

printf "\n%sTeamAgent%s 接入 %s\n\n" "$B" "$N" "$SERVER"

step "服务端"
curl -fsS -o /dev/null -m 10 "$SERVER/api/v1/install.sh" >>"$LOG" 2>&1 || fail "连不上 $SERVER，这台电脑要能访问到它（127.0.0.1 只在服务端那台电脑上有效）"
ok

step "git"; command -v git >/dev/null || fail "先装 git（macOS：xcode-select --install）"; ok
step "bun"
if ! command -v bun >/dev/null; then
  [ -x "$HOME/.bun/bin/bun" ] || run bash -c "curl -fsSL https://bun.sh/install | bash"
  export PATH="$HOME/.bun/bin:$PATH"
fi
ok "$(bun --version)"

step "守护进程"
if [ -d "$APP/.git" ]; then
  origin="$(git -C "$APP" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *Sailfishc/noop*|"$REPO") run git -C "$APP" pull -q --ff-only || true ;;
    *) fail "$APP 已经装了别的 noop（$origin）。换个目录再装：NOOP_HOME=~/.teamagent 加在命令最前面" ;;
  esac
else
  run git clone -q "$REPO" "$APP"
fi
(cd "$APP" && run bun install --frozen-lockfile)
ok "$(git -C "$APP" rev-parse --short HEAD)"

export NOOP_HOME="$HOME_DIR"
step "接入"
out="$(cd "$APP" && bun src/cli.ts join "$SERVER" "$CODE" 2>&1)" || fail "$out"
ok "${out#已接入 }"

step "Runtime"
found=(); for c in codex claude pi; do command -v "$c" >/dev/null && found+=("$c"); done
if [ ${#found[@]} -gt 0 ]; then ok "${found[*]}"; else warn "没找到 codex、claude 或 pi，装好并登录一个，Agent 才能干活"; fi
step "GitHub"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then ok "gh 已登录"; else warn "gh 没登录：推分支、开 PR 前运行 gh auth login"; fi

step "后台服务"
if (cd "$APP" && run bun src/cli.ts install); then ok; else warn "没装成后台服务，可以手动运行：cd $APP && bun run daemon"; fi

printf "\n  完成。回到客户端的「我的机器」，这台电脑应该在一分钟内显示在线。\n  日志：%s\n\n" "$([ "$(uname)" = Darwin ] && echo "$HOME_DIR/data/logs/daemon.log" || echo "journalctl --user -u noop -f")"
