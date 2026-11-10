# 在团队机器上建一个团队 Agent

目的：频道里有一个大家都能直接 @ 的同事，不依赖某个人的电脑开着，也不用等谁点「确认开工」。
阶段 0 是一周试用，这一周里看「设置 → 协作数据」：大家更愿意 @ 团队 Agent 还是各自的 Agent。
阶段 2 起，团队机器、团队 Agent 和团队配置仓库都是产品里的东西，不再靠手工约定（见第 2、4、5 步）。

需要准备：

- 一台常开、能访问 Remi 服务端和内部 GitLab 的机器（下面叫「团队机器」），Linux 或 macOS。
- 内部 GitLab 的机器人账号，以及它的访问令牌（scope `api`）。
- 团队机器上装好并登录一个 Runtime：Codex、Claude Code 或 Pi。

## 1. 先定机器人账号能碰什么

团队 Agent 用机器人账号的令牌推分支、开 PR。**共用凭证就是共用权限**：频道里谁 @ 它，谁就借用了这个账号的权限。所以：

- 只给机器人账号加全队本来都能看的仓库，角色 Developer（能推分支、开合并请求，不能改受保护分支）。
- 敏感仓库不要加给它；需要的话放到另一台 Computer、另一个账号。
- 受保护分支照常开着：机器只推 `agent/T-xxxx` 分支，合并永远由人来做。

## 2. 把团队机器接进来

由**管理员**（团队 Agent 的负责人）来做，这样机器和 Agent 的主人是负责人，而不是某个同事。

1. 管理员在 App 里「设置 → 我的机器 → 添加机器」，复制那一行接入命令。
2. 在团队机器上，用一个专门的系统用户（比如 `remi`，不要用 root）运行它：

   ```sh
   curl -fsSL http://remi.内网域名:8080/api/v1/install.sh | bash -s -- http://remi.内网域名:8080 tj_…
   ```

   Linux 上它会装成 `systemd --user` 服务并开启 linger，没人登录也一直跑。常开机器建议再关掉休眠：
   `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`。
3. 机器连上后会以主机名出现在「我的机器」里，改个好认的名字，比如「团队机器」。
4. 在机器卡片上点「设为团队机器」。之后**所有管理员**都能在这台机器上建 Agent、改它上面 Agent 的设置，
   不只是添加它的那个人；卡片上能看到它的 Git 身份（机器人账号）、技能和 MCP、团队配置的同步情况。

## 3. 配机器人令牌和提交身份

在团队机器上编辑 `~/.noop/data/config.local.toml`，加上：

```toml
[[git.gitlab]]
host = "code.公司.com"
token = "机器人账号的令牌"
```

再设置这台机器上 git 提交用的身份，让提交记录一眼看出是机器人做的：

```sh
git config --global user.name "remi-bot"
git config --global user.email "机器人账号的邮箱"
```

然后重启守护进程（`systemctl --user restart noop`，macOS 上 `launchctl kickstart -k gui/$(id -u)/dev.noop.daemon`），
运行 `bun ~/.noop/app/src/cli.ts doctor` 检查：GitLab 那一行应该显示机器人账号的用户名。
App 里「设置 → Git 平台 → 我的机器上的凭证」也会显示同样的结果（只显示有没有、是谁，令牌不离开机器）。

## 4. 建团队 Agent

管理员在「设置 → 我的 Agent → 新建」：

- 机器：团队机器；Runtime 选那台机器上登录好的。
- 名字和 @名按角色起，比如「开发助手」`@dev`，不要用人名。
- 谁能派活：**整个团队**；**需要我确认：关**。建在团队机器上的 Agent 默认就是这样，谁 @ 都直接开工；在它还没加入的频道被 @ 时会自己加入。
- 负责人：在 Agent 页面的「团队 Agent」一栏里选（管理员可以改）。负责人对它负责，需要确认的事由负责人确认。
- 描述里写清楚它适合做什么，比如「适合改代码、查问题、写文档」。

## 5. 团队配置仓库：约定、skills 和 MCP

建一个 Git 仓库（比如 `team/remi-config`，每台机器都要能克隆），管理员在「设置 → 团队配置」里填上地址。
每台机器都会同步一份（每 10 分钟看一次），交给它上面的所有 Agent：

```
AGENTS.md          团队约定：每个 Agent 开始任务时都会读
skills/<名字>/SKILL.md   一个技能一个文件夹；链接到 ~/.claude/skills、~/.codex/skills、~/.pi/agent/skills
mcp.json           MCP 服务器，格式同 Claude Code：{"mcpServers": {"jira": {"command": "…", "env": {"JIRA_TOKEN": "${JIRA_TOKEN}"}}}}
```

- 密钥写成 `${名字}`，每台机器从自己的环境变量或 `config.local.toml` 的 `[remi.env]` 里填（`JIRA_TOKEN = "…"`），
  密钥不进仓库、不进服务端。缺值的 MCP 服务器在那台机器上会被跳过，机器卡片上会写明缺什么。
- Claude Code 用 `--mcp-config` 拿到这些服务器并逐个放进允许列表；Codex 用 `-c mcp_servers.…`；Pi 不支持 MCP。
- 改团队的规矩就是往这个仓库提交；频道自己的约定写在频道「成员」面板的「频道约定」里，Agent 会先读频道的再读团队的。
- 机器上原来就有的 skills 和 MCP（`~/.claude/skills/`、`claude mcp add -s user …`、仓库里的 `.mcp.json`）照样能用，
  同名的技能以机器自己的为准。

仓库自己的准备工作（装依赖、生成代码）放在那个仓库的 `.remi/setup.sh` 里：机器为任务新开 worktree 时跑一次
（最多 10 分钟，同样不能推送），结果会告诉 Agent。

## 6. 试一周

- 在频道里发一条「@dev …」试试：任务卡会直接从「等机器认领」开始，不需要确认。
- PR 正文会写明是谁派的，合并仍然由人做。
- 一周后看「设置 → 协作数据」：团队 Agent 的任务来自几个人、人回复「待你处理」要多久、每个任务跑了几轮、有多少任务取消后重来。

发起人不在时，频道里的其他人可以在任务线程里点「接手」：任务改由接手的人发起，之后由他回答问题、验收，
任务卡上会写明是从谁手里接过来的。

出问题时先找负责人：机器离线、Runtime 登录过期、令牌失效都会在 Agent 的状态点和机器卡片上显示出来。
