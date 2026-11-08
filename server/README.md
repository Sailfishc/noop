# TeamAgent server（Go）

自部署的协调服务端，替代 `cloud/` 里的 Cloudflare Worker。它实现了和 Worker 相同的 HTTP 接口，所以 noop 的客户端和守护进程不用改代码，改一下地址就能连上。

- 纯 Go，单个二进制文件。依赖只有 `modernc.org/sqlite`（纯 Go 实现，不需要 cgo）和 `github.com/coder/websocket`。
- 所有数据都放在一个 SQLite 文件里，表结构和 Worker 的 Durable Object 一致。
- 机器只向外连接服务端，服务端不需要能访问到机器。

## 运行

```sh
cd server
go build -o teamagent-server ./cmd/teamagent-server
TEAMAGENT_TOKEN=<机器 token> ./teamagent-server -addr :8080 -data /var/lib/teamagent
```

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `TEAMAGENT_TOKEN`（必填） | 机器 token，也就是 noop.toml 里 `[server] token` 的值，至少 16 个字符 |
| `-addr` / `TEAMAGENT_ADDR` | 监听地址，默认 `:8080` |
| `-data` / `TEAMAGENT_DATA` | 数据目录，数据库文件是 `hub.db` |
| `-owners` / `TEAMAGENT_OWNER_EMAIL` | 允许登录的邮箱，多个用逗号分隔 |
| `TEAMAGENT_SMTP` | 发验证码用的邮箱配置，JSON 格式 `{host, port, secure, user, pass, from}`。不配置时，验证码改由主机上的 `noop login` 显示 |
| `-static` / `TEAMAGENT_STATIC` | Web 客户端目录（`app/dist/web/noop`）。为空时只提供 API |

机器侧在 `~/.noop/noop.toml` 里把地址指向这台服务器：

```toml
[cloud]
url = "http://teamagent.内网域名:8080"
[server]
token = "<同一个机器 token>"
```

两步验证仍然在机器上绑定（`noop 2fa setup`）。不绑定的话，任何人都无法登录。

## 已实现的接口

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
TEAMAGENT_TOKEN=e2e-token-0123456789 ./teamagent-server -addr 127.0.0.1:18080 -data /tmp/ta &
TEAMAGENT_TOKEN=e2e-token-0123456789 bun server/test/e2e-claim.ts http://127.0.0.1:18080
```
