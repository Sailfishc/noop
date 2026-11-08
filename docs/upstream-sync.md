# 同步上游 noop

TeamAgent 是 [huacnlee/noop](https://github.com/huacnlee/noop) 的 fork。上游还在快速迭代，其中一部分对我们有用，一部分和我们的方向冲突。这份文档说明要不要同步、怎么判断、怎么操作。

## 结论

**要同步，但只拿有用的，并且永远经过 PR，不直接进 `main`。**

原因有两个：

- 客户端底座（NSH 组件、聊天时间线、侧边栏）和机器侧的运行时代码（Codex 调用、账号、worktree）上游一直在修，自己重写不划算。
- 机器守护进程会跟着 `main` 自动更新（见 `src/setup.ts` 的 `selfUpdate`）。合进 `main` 的东西会在几分钟内到达所有人的机器，所以 `main` 上的任何同步都必须先过 CI 和端到端测试。

GitHub 页面上的「Sync fork」按钮会把上游直接合进 `main`，**不要点**。

## 按目录判断

| 上游改动的位置 | 判断 | 理由 |
| --- | --- | --- |
| `app/ui/`、通用组件、主题、字体、i18n 基础设施 | 拿 | 我们的界面建立在这些组件上 |
| `NSH_REF`、`app/.nsh/types`、`.github/actions/setup-nsh` | 拿 | NSH 升级和它的类型要跟上，否则客户端构建会落后 |
| 运行时与执行：Codex/Claude Code 的调用、账号切换、worktree、日志 | 拿，逐个看 | 这是我们 runtime adapter 的上游来源，修复通常直接适用 |
| 安全修复、依赖升级 | 拿 | 不管在哪个目录 |
| `src/core.ts`、`src/cli.ts`、`app/App.tsx` | 逐个看 | 我们也改了这些文件，最容易冲突；只拿修 bug 的部分 |
| `cloud/`（Cloudflare Worker）、`install*.sh`、`install*.ps1`、`website/` | 不拿也行 | 我们用 Go 服务端和自己的部署方式。合进来不影响运行，但不用为它解决冲突 |
| 单人模式的产品功能：brain、routines、owner 学习决策、单人频道 | 默认不拿 | 和多人模型冲突。真正有价值的想法，按 TeamAgent 的模型重新实现 |
| `.github/workflows/release.yml`、`app/nsh.json` 的 updater | 不拿 | 指向上游的 Release 和签名密钥 |

拿不准的时候，问三个问题：

1. **它修的问题我们也有吗？** 没有就不拿。
2. **它碰到了我们改过的文件吗？** 碰到了，就看冲突要改多少。冲突比改动本身还大，就不拿，或者只摘出需要的几行。
3. **拿了之后测试还全过吗？** 不过就不拿，或者在同步分支里改到全过。

## 合并还是挑拣

现在两边差得还不多（把 M1–M3 合进当前 `main` 的试合并没有冲突），可以继续**整体合并**，省事，也方便以后对比。

出现下面任一情况时，改为**只挑拣（cherry-pick）**需要的提交：

- 一次合并有超过 5 个文件需要手动解决冲突；
- 合进来的功能需要额外写代码去关掉；
- 上游改动了我们已经重写的部分（比如任务模型、频道、登录）。

改为挑拣以后，在同步 PR 的描述里记下「已同步到上游的哪个提交」，下次从那里往后看。

## 操作步骤

建议每两周看一次，或者上游发了重要修复时看一次。

```sh
git remote add upstream https://github.com/huacnlee/noop   # 第一次
git fetch upstream main

# 看上游新了什么，按目录分开看
git log --oneline main..upstream/main
git log --oneline main..upstream/main -- app/ui app/.nsh .github/actions
git log --oneline main..upstream/main -- src

# 在同步分支上做
git checkout -b sync/upstream-$(date +%Y%m%d) main
git merge upstream/main          # 或者：git cherry-pick <提交>…
```

合并后在本地跑一遍：

```sh
bun test
cd server && go test -race ./...
cd app && nsh test
```

再推上去开 PR 到 `main`，等 CI（包括 `server/test/` 里的三个端到端脚本）全绿再合并。CI 不跑客户端测试，所以 `nsh test` 一定要在本地跑。PR 描述里写清楚拿了什么、跳过了什么、为什么跳过。
