# TeamAgent

一个团队里的几个人，加上每个人自己的几个 AI Agent，在同一个地方一起干活。

TeamAgent 是从 [huacnlee/noop](https://github.com/huacnlee/noop)（MIT）分出来的实验项目。noop 是「一个人 + 一队 Agent」，TeamAgent 改成「多个人 + 多个 Agent」：频道里的人可以 @ 某人的 Agent 派活，Agent 在主人自己的电脑上用 Codex 干活，结果、需要人拍板的决定和 PR 都回到频道的线程里。整套东西自己部署在公司内网，不依赖 Cloudflare 或任何 SaaS。

## 它是什么样的

- **每个 Agent 都有主人。** Agent 跑在主人的机器上，用主人的仓库和凭证。主人决定谁能给它派活：只有主人、需要主人确认（默认）、或者频道里谁都能直接派。
- **派活就是 @。** 在频道里 @Agent 说一句话，就生成一张任务卡。主人点「确认开工」后，机器认领任务，在 `agent/T-xxxx` 分支的独立 worktree 里用 Codex 干活，进度实时显示在卡片上。
- **需要人的时候才打扰人。** Agent 遇到要拍板的事会给出几个选项，出现在「待你决定」里，点一下就继续。在任务线程里回复，Agent 会接着上次的会话继续做。
- **代码只能经过 PR。** Agent 自己推不了代码。机器只推 `agent/` 开头的分支，并在 GitHub 或 Ant Code（基于 GitLab）上开 PR，合并永远由人来做。PR 合并后任务自动完成。
- **自己部署，依赖很少。** 服务端是一个 Go 二进制文件加一个 SQLite 文件，部署在内网一台机器上。机器只向外连服务端，服务端不需要能访问机器。

v1 的范围：10 人以内、每人 1–2 个 Agent；运行时只有 Codex（Claude Code 在第二阶段）；客户端先保证 macOS Apple 芯片。

## 组成

| 部分 | 目录 | 说明 |
| --- | --- | --- |
| 服务端 | `server/` | Go，单个二进制。账号与邀请、频道、消息、任务、「待你决定」、Git webhook。数据在一个 SQLite 文件里 |
| 机器守护进程 | `src/` | TypeScript / Bun。每台跑 Agent 的电脑上一个，负责认领任务、调 Codex、推分支、开 PR、查 CI |
| 客户端 | `app/` | 基于 [NSH](https://github.com/longbridge/nsh) 的跨平台 App（macOS、Linux、Windows、iOS、Android、Web） |

```
 人（客户端）──┐                         ┌── 机器 A：守护进程 → Codex → agent/T-0001 → PR
              ├──► TeamAgent 服务端 ◄────┤
 人（客户端）──┘   （内网，Go + SQLite）    └── 机器 B：守护进程 → Codex → …
                        ▲
                        └── Ant Code / GitHub webhook（PR 合并）
```

## 部署

完整的参数和接口见 [server/README.md](server/README.md)。下面是从零到能派活的最短路径。

### 1. 服务端（内网一台机器）

需要 Go 1.26+。

```sh
git clone https://github.com/Sailfishc/noop teamagent && cd teamagent/server
go build -o teamagent-server ./cmd/teamagent-server

# 第一个管理员：打印一个邀请链接，用它在客户端里注册
./teamagent-server invite -data /var/lib/teamagent -email 你@公司.com -role admin -url http://teamagent.内网域名:8080

# 启动（建议用 systemd 或 launchd 托管）
TEAMAGENT_GIT_WEBHOOK_SECRET=一串随机字符 ./teamagent-server -addr :8080 -data /var/lib/teamagent
```

要备份，就备份数据目录里的 `hub.db`。

### 2. 客户端

不要用 noop 官网的安装脚本或 huacnlee/noop 的 Release：那是上游的 noop，没有 TeamAgent 的界面。客户端从这个仓库的 `app/` 构建，需要先按 [NSH](https://github.com/longbridge/nsh) 的说明装好 `nsh`（版本见 `.github/workflows/release.yml` 里的 `NSH_REF`）。

```sh
cd app
nsh package --target macos -o dist/macos        # 桌面 App
./build-web.sh                                   # 或者构建 Web 版，到 dist/web/noop
```

客户端的自动更新（`app/nsh.json` 的 `updater`）已经指向本仓库。本仓库还没有发布 Release，所以现在不会自动更新，更新时重新构建即可。

Web 版可以直接让服务端托管：启动时加 `-static ../app/dist/web/noop`，大家用浏览器打开服务端地址就行。

打开 App，选「我有邀请」，粘贴邀请链接，填名字和 @名就登录了。换一台设备时，在已登录的设备上点「Agent 与机器 → 在其他设备登录」生成一次性登录码（15 分钟有效），在新设备上输入即可；设备丢了就找管理员要一个登录链接（一天有效）。管理员在「Agent 与机器」里给同事发邀请。

### 3. 机器（每台跑 Agent 的电脑）

需要 git，以及装好并登录的 Codex、Claude Code 或 Pi 之一；推分支、开 PR 还要 `gh auth login`。

在客户端的「设置 → 我的机器 → 添加机器」里起个名字，点「生成接入命令」，把给出的一行命令复制到那台电脑的终端里运行：

```sh
curl -fsSL http://teamagent.内网域名:8080/api/v1/install.sh | bash -s -- http://teamagent.内网域名:8080 tj_…
```

它会：没有 Bun 就装上；把守护进程装到 `~/.noop/app`；用一次性接入码（一小时内有效）换到这台机器的令牌，写进 `~/.noop/data/config.local.toml`；检查 Runtime 和 gh；最后装成后台服务（macOS 用 launchd，Linux 用 systemd --user），开机自启、关掉终端也不停。一分钟内客户端里这台机器会显示在线。日志在 `~/.noop/data/logs/daemon.log`（macOS）或 `journalctl --user -u noop -f`（Linux）。

注意客户端登录用的服务端地址要是那台电脑能访问到的地址：`127.0.0.1` 只在服务端自己那台电脑上有效。接入码过期了、或者机器离线需要重新接入时，在机器卡片上点「接入命令」重新生成一条（会换一个新令牌）。

推分支、开 PR 用的凭证按需写进同一个 `config.local.toml`：

```toml
[git.github]
token = "…"                 # 不填就用 gh auth token

[[git.gitlab]]              # 基于 GitLab 的平台
host = "code.公司.com"
token = "…"                 # 主人自己的 token，对仓库至少要有 Developer 权限
```

也可以手动配置：在接入命令下面点「手动配置」，把显示的 `[cloud]`、`[server]` 几行写进 `config.local.toml`，然后在仓库目录里 `bun install && bun run daemon`。

有了 TeamAgent 的机器 token，守护进程只跑 TeamAgent：不需要 noop 的 `init`，也不会启动 noop 单人模式的那些东西。

守护进程会跟随这个仓库的 `main` 自动更新：发现 `origin/main` 有新提交时，先跑 `bun test`，通过了才切换，失败就回滚。所以 `main` 就是线上版本，合进 `main` 的东西会自动到达所有机器。

### 4. 建 Agent 并派活

1. 在「我的 Agent」里新建一个 Agent，选它跑在哪台机器、用哪个 Runtime，再选派活方式。Agent 不绑定仓库。
2. 仓库跟着任务走，按这个顺序决定：消息里写的仓库地址（如 `https://github.com/acme/pay`，或者某台机器上已有仓库的 `acme/pay`）→ 同一线程里之前任务用的仓库 → 频道的默认仓库（在频道的「成员」面板里设置）→ 都没有就是通用任务，在一个空目录里做。任务开始前，发起人可以在任务卡上换仓库。
3. 机器会在 `~/code`、`~/work`、`~/src`、`~/projects` 等目录（最多往下三层）里找本地仓库，按远端地址上报，只报地址，不报路径。要指定其他目录，在 `config.local.toml` 里写 `[teamagent]` 的 `roots = ["~/somewhere"]`。任务要用的仓库本机没有时，机器会用自己的 git 凭证自动克隆到 `~/.noop/data/teamagent/repos/`。
4. 在频道里 @它说一句话。需要确认的话，主人在任务卡或「待你决定」里点「确认开工」。
5. 干完后线程里会有 Agent 的总结和 PR 链接。PR 的 CI 状态由机器每两分钟查一次。
6. 每个 Agent 有自己的记忆（memory.md），主人在「我的 Agent」里可以编辑。Agent 每次开工前会读它，学到以后用得上的东西时会自己改写。
7. 产出：Agent 放进工作目录 `out/` 的文件会上传到服务端，在任务卡上能预览、下载（同名文件再传是新版本）；PR 和外部服务里的结果（比如渲染任务）也列在产出里。消息附件会放进 `in/` 给 Agent 用。
8. 等外部结果：要等外部服务出结果时，Agent 会把任务挂成「等待外部结果」，并说清楚靠什么叫醒它：回调地址、本机定时跑的查询命令，或者一个时间。等待期间不占机器、不打扰任何人，到点或有结果时 Agent 被叫醒继续。每个任务最多向外部提交 3 次（失败或超时都算），之后由发起人决定。任务卡会标明「结果已确认」还是「已提交，结果未确认」。

### 在一台电脑上先跑通

想先自己一个人、一个 Agent 跑通，可以把服务端、客户端和守护进程都放在同一台 Mac 上。前提是装好 Go、Bun、git、`nsh` 和已登录的 Codex。

```sh
git clone https://github.com/Sailfishc/noop ~/teamagent && cd ~/teamagent && bun install

# 1. 服务端（一个终端）
cd server && go build -o teamagent-server ./cmd/teamagent-server
./teamagent-server invite -data ~/teamagent-data -email 你@公司.com -role admin -url http://127.0.0.1:8080
./teamagent-server -addr 127.0.0.1:8080 -data ~/teamagent-data

# 2. 客户端（另一个终端）
cd ~/teamagent/app && nsh run
```

3. 在 App 里选「我有邀请」，粘贴上面打印的邀请链接，填名字和 @名。
4. 在「设置 → 我的机器」里添加机器，在终端运行给出的接入命令（同一台电脑上用 `127.0.0.1` 没问题）。
5. 新建 Agent，机器选刚才那台，然后建一个频道把它拉进来，在频道的「成员」面板里把默认仓库设成一个有远端的仓库地址（比如 `https://github.com/你/demo`）。
6. 在频道里发「@它 帮我加一个 hello.txt」。主人给自己的 Agent 派活不需要确认，会直接开工。任务卡会依次显示「等机器认领 → 进行中 → 待验收」，Agent 的总结出现在线程里，改动在仓库的 `agent/T-0001` 分支上。
7. 在线程里回复一句，Agent 会接着同一个会话继续做。

只有本地仓库、没有 `origin` 的话，在 Agent 设置的「本机默认仓库」里填它的路径；Agent 的改动只留在本地分支上，不会推送或开 PR。要试 PR，就用一个有 GitHub 远端的仓库，并在 `config.local.toml` 里配好 `[git.github]`。

### 5. Ant Code webhook（可选）

在 Ant Code 仓库的集成服务里加一个 webhook：

- 地址：`http://teamagent.内网域名:8080/api/v1/hooks/gitlab`
- 密钥：服务端的 `TEAMAGENT_GIT_WEBHOOK_SECRET`
- 事件：勾选 PullRequest

这样 PR 一合并，任务就马上变成「已完成」。不配也能用，机器轮询也会发现，只是慢一点。

## 开发与测试

```sh
bun test                                   # 守护进程
cd server && go test -race ./...           # 服务端
cd app && nsh test                         # 客户端
```

端到端脚本（多人协作、派活全链路）在 `server/test/`，用法见 [server/README.md](server/README.md#测试)。CI 会跑守护进程、服务端和端到端测试；客户端测试需要本地装好 nsh 再跑。

## 和上游 noop 的关系

这个仓库是 huacnlee/noop 的 fork，但产品形态已经不同：noop 是单人自用、跑在 Cloudflare 上；TeamAgent 是多人、自部署、Go 服务端。noop 的单人模式不再保证可用。上游的代码仍然有很多值得拿的东西，同步规则见 [docs/upstream-sync.md](docs/upstream-sync.md)。

## License

MIT。上游 noop 的版权归原作者所有，见 [LICENSE](LICENSE)。
