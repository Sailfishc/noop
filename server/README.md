# Remi server（Go）

自部署的协调服务端，替代 `cloud/` 里的 Cloudflare Worker。它实现了和 Worker 相同的 HTTP 接口，所以 noop 的客户端和守护进程不用改代码，改一下地址就能连上。

- 纯 Go，单个二进制文件。依赖只有 `modernc.org/sqlite`（纯 Go 实现，不需要 cgo）和 `github.com/coder/websocket`。
- 所有数据都放在一个 SQLite 文件里，表结构和 Worker 的 Durable Object 一致。
- 机器只向外连接服务端，服务端不需要能访问到机器。

## 运行

```sh
cd server
go build -o remi-server ./cmd/remi-server
export REMI_PUBLIC_URL=http://remi.内网域名:8080   # 别人访问这台服务器用的地址
./remi-server invite -data /var/lib/remi -email 你@公司.com -role admin   # 第一个管理员
./remi-server -addr :8080 -data /var/lib/remi
```

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `-addr` / `REMI_ADDR` | 监听地址，默认 `:8080` |
| `-public-url` / `REMI_PUBLIC_URL` | 别人访问服务器用的地址（如 `http://remi.内网域名:8080`）。App 生成的邀请链接、登录链接、机器安装命令，以及 Agent 等待外部结果用的回调地址都用它。不设置时，App 用自己连接服务器的地址；如果那个地址是 `127.0.0.1`（比如走 SSH 隧道），发出去的链接别人就连不上 |
| `-data` / `REMI_DATA` | 数据目录，数据库文件是 `hub.db` |
| `-git-webhook-secret` / `REMI_GIT_WEBHOOK_SECRET` | Ant Code（GitLab）webhook 的密钥。为空时不收 webhook |
| `REMI_TOKEN` | 可选，只给老的 noop 单人模式用（至少 16 个字符） |
| `-static` / `REMI_STATIC` | Web 客户端目录（`app/dist/web/noop`）。为空时只提供 API |

## 怎么用起来

1. **加入团队**：管理员在 App 的「Agent 与机器」里生成邀请链接发给同事。对方打开 App，选「我有邀请」，填名字和 @名就登录了。换设备时在已登录的设备上生成一次性登录码（15 分钟有效）；设备丢了由管理员生成登录链接（一天有效）。
2. **接入机器**：在「我的机器」里添加一台，把显示的几行写进那台电脑的 `~/.noop/data/config.local.toml`，然后在仓库目录里运行（或重启）`bun run daemon`：

   ```toml
   [cloud]
   url = "http://remi.内网域名:8080"
   [server]
   token = "tam_…"
   ```

3. **建 Agent**：在「我的 Agent」里新建，选它跑在哪台机器上，并填写它在那台机器上用的代码仓库路径（比如 `~/work/orders`），再设置谁能给它派活。
4. **派活**：在频道里 @它，它就会接手（需要主人确认时，先等主人点「确认开工」）。只是问答的，它直接在线程里回复；要动手的，它认领为任务，出现任务卡；发送前勾「作为任务」则一开始就是任务。机器在 `agent/T-xxxx` 分支的独立 worktree 里用 Codex 干活，结果作为 Agent 的回复出现在线程里。之后在线程里回复，Agent 会接着上次的会话继续做。

   任务对人只有 5 个状态（`status`：todo、in_progress、in_review、done、closed）和一个「需要你」标记（`needs`：confirm、decide、unblock、retry）。底下的 `state` 是运行状态机（pending、queued、running、waiting、needs_decision、blocked、failed、review、done、closed），只给机器用，映射见 `internal/hub/teamtasks.go` 的 `statusOf`。`tracked` 表示是不是被跟踪的任务；问答只是一次对话，不进任务看板。

   Agent 运行时可以用 `remi` 命令查上下文（`/api/v1/agent/*`，见 `internal/hub/teamcontext.go`），凭据是这次运行的只读 token，只在任务运行期间、只在 Agent 所在的频道里有效。
5. **PR**：Agent 自己不能推送代码。由机器把 `agent/T-xxxx` 推上去，并在 GitHub 或 Ant Code 开 PR。合并永远由人来做。机器侧要有平台凭证：

   ```toml
   [git.github]
   token = "…"                     # 不填就用 gh auth token
   [[git.gitlab]]                  # Ant Code 等基于 GitLab 的平台
   host = "code.公司.com"
   token = "…"
   # api = "https://code.公司.com/api/v4"   # 默认就是这个
   ```

   在 Ant Code 的集成服务里加一个 webhook，地址填 `http://remi.内网域名:8080/api/v1/hooks/gitlab`，密钥填 `-git-webhook-secret` 的值，勾选 PullRequest 事件。PR 合并后，对应的任务会自动变成「已完成」。CI 状态由机器每两分钟查询一次。

## 已实现的接口

Remi 自己的接口都在 `/api/v1` 下，包括账号与邀请、机器、Agent、频道、消息、线程、任务、「待你决定」和 webhook，具体见 `internal/hub/v1.go`。下面是为老的 noop 单人模式保留的接口：

| 范围 | 接口 |
| --- | --- |
| 文件同步 | `/api/files/changes`、`/commit`（按路径做 compare-and-swap，任务认领靠它保证只有一台机器成功）、`/history`、`/revert`、`/list`、`/read` |
| 消息流 | `/api/feed`、`/api/messages`（用 client_id 去重）、`/api/stream` WebSocket（`?v=2` 时推送状态帧） |
| 机器 | `/api/events`、`/api/host/state`、`/api/host/inbox`（支持长轮询 `wait`）、`/api/host/stream` WebSocket |
| 登录 | `/api/auth/start`、`/verify`、`/logout`，`/api/host/2fa*`、`/login-code`、`/join`、`/revoke-sessions` |
| 其他 | `/api/status`、`/api/settings`、`/api/uploads`、`/api/media`、`/media/<id>`、`/api/tasks*`、`/api/channels*`、`/api/fleet/update`、`/api/usage` |

还没有移植：MCP 和 OAuth 连接器、Web Push（`/api/push/answer` 可用，其余返回 503）、导出导入、IP 白名单。另外，和 Worker 不同的是，`/api/events`、`/api/host/state` 和 `/api/host/inbox` 只接受机器 token。

## 测试

```sh
cd server && go test -race ./...
# 端到端：用 noop 自己的主机代码（src/core.ts 的 pull + claim），让三台模拟主机抢同一个任务
REMI_TOKEN=e2e-token-0123456789 ./remi-server -addr 127.0.0.1:18080 -data /tmp/ta &
REMI_TOKEN=e2e-token-0123456789 bun server/test/e2e-claim.ts http://127.0.0.1:18080
# 多人：两个人、一台机器、一个 Agent、一个频道
CODE=$(./remi-server invite -data /tmp/tb -email zhang@corp.com | tail -1 | sed 's|.*/invite/||')
./remi-server -addr 127.0.0.1:18081 -data /tmp/tb &
bun server/test/e2e-team.ts http://127.0.0.1:18081 "$CODE"
# 派活全链路：@Agent → 确认 → 守护进程用（假的）codex 在 worktree 里干活 → 推分支 → 线程里追问续跑
CODE=$(./remi-server invite -data /tmp/tc -email zhang@corp.com | tail -1 | sed 's|.*/invite/||')
./remi-server -addr 127.0.0.1:18082 -data /tmp/tc &
bun server/test/e2e-dispatch.ts http://127.0.0.1:18082 "$CODE"
```
