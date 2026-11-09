# 客户端自动更新

参考 LoopMe 的 Mac 自动更新（Sparkle + GitHub Releases + 签名的 appcast）。Remi 的客户端基于 NSH，NSH 自带同样角色的 `nsh/updater`，所以不用 Sparkle：安装包和更新信息放在本仓库的 GitHub Releases 上，App 自己检查、下载、校验签名，提示「重启以更新」。仓库需要是公开的（App 下载时不带凭据）。

## 谁负责什么

| 部分 | 负责什么 |
| --- | --- |
| App 内（`app/update.ts` 决定，`app/team/updates.tsx` 显示） | 打开 5 秒后检查一次，之后每小时一次，读 `https://github.com/Sailfishc/noop/releases/latest/download/latest.json`。有新版本就后台下载、校验，侧栏底部出现「重启以更新到 x」，重启由人来点。用户菜单里有「检查更新」，结果显示在同一个位置 |
| 发版流水线（`.github/workflows/release.yml`） | 推 `vX.Y.Z` tag 触发：打 Mac（Apple 芯片）和 Linux 包，签名 OTA 代码包，写并签名 `latest.json`，先以草稿上传、再设为 latest |
| GitHub Releases | 每个版本一个 Release（tag `vX.Y.Z`），附件见下 |
| 密钥（`scripts/release-keys.sh`） | 根密钥离线保存；发版密钥放仓库 secret；两个公钥放仓库 variable，构建时写进 App |

两种更新，App 自动选：

- **OTA 代码包**（`remi-<版本>.nshpkg`）：只改了 TSX 的版本，App 下载签名过的代码包，重启后生效，不用换整个 App。手机上也能用（下次打开时生效）。新包先「试运行」，启动就崩会自动退回上一版。
- **整个 App**（`remi-<版本>-macos-arm64.tar.gz` 等）：升级了 NSH 运行时的版本，代码包跑不了，就下载整个 App，校验后替换并重启。

`releases/latest/download/latest.json` 总是指向最新 Release 里的那份，所以不会有覆盖文件或缓存的问题；草稿和预发布（比如 CI 的 `nsh-<commit>`）App 看不到。

### 和 LoopMe 的对应

| LoopMe | Remi |
| --- | --- |
| Sparkle | `nsh/updater`（NSH 自带） |
| `appcast.xml` + EdDSA 签名 | `latest.json` + `latest.json.sig`，发版密钥签名 |
| 公钥放在已忽略的 `release.env`，没填就不开更新 | 公钥放仓库 variable，由 `scripts/release-config.sh` 在 CI 里写进 `app/nsh.json`；本地和 fork 的构建没有 `updater`，不会更新 |
| 本机跑 `release-mac.sh` | 推 tag，GitHub Actions 跑 |
| 改 `CURRENT_PROJECT_VERSION` | 版本号取自 tag，build 号取自 CI 运行序号，自动递增 |
| 先草稿再设为 latest | 同样 |
| 安装前停掉 daemon | 不需要：机器守护进程不在 App 里，它自己跟着 `main` 更新（`src/setup.ts` 的 `selfUpdate`） |
| 「自动安装更新」开关 | 暂不做：重启始终由人来点 |
| 公证（notarize） | 暂不做：App 只做了 ad-hoc 签名。用安装脚本（curl）装的、App 自己下载替换的，一般没有隔离标记，Gatekeeper 不拦（还没在真机上验证）；在浏览器里下载 zip 再打开会被拦，要右键「打开」 |

## 一次性准备

在自己的 Mac 上（装好 `nsh`，见 README；`gh auth login` 的账号能改本仓库设置）：

```sh
scripts/release-keys.sh
```

它在 `~/.remi-release-keys` 生成两把密钥，并写进仓库设置：

- variable `REMI_UPDATE_ROOT`（根公钥）、`REMI_UPDATE_KEY`（发版公钥）：构建时写进 App
- secret `REMI_RELEASE_KEY`（发版私钥）、`REMI_RELEASE_CERT`（根密钥给发版密钥的证书，默认 730 天）

**根私钥 `root.secret` 一定要离线备份**（密码管理器或加密 U 盘），丢了，已装的 App 就再也收不到 OTA 代码包。证书快到期时跑 `scripts/release-keys.sh renew`。这些文件都不进仓库。

## 发一个版本

```sh
git tag v0.2.0 && git push origin v0.2.0
```

流水线打包、签名、发布。第一次要在 Mac 上编译 NSH，可能要半小时以上；之后按 NSH 版本缓存，快很多。没配密钥时 tag 构建会直接失败，不会发出一个不能更新的版本。

第一次安装用安装脚本（之后都自动更新）：

```sh
curl -fsSL https://raw.githubusercontent.com/Sailfishc/noop/main/install-client.sh | bash
```

## 注意

- 本仓库的「最新 Release」必须是客户端版本。发别的 Release 时不要勾 latest（CI 的 `nsh-<commit>` 已经是预发布）。
- **第一个带更新的版本要手动装一次**：之前自己构建的 App 没有 `updater`（或者信任的是上游 noop 的密钥），收不到更新。
- 改了公钥（重新生成密钥）等于换了信任，已装的 App 要手动重装。只续证书（`renew`）不受影响。
- Linux 包只依赖 GTK 4（不带 WebKitGTK）。Windows、iOS、Android 先不发；需要时在 `release.yml` 的矩阵里加。
