# 客户端自动更新

参考 LoopMe 的 Mac 自动更新（Sparkle + GitHub Releases + 签名的 appcast，本机脚本发版）。Remi 的客户端基于 NSH，NSH 自带同样角色的 `nsh/updater`，所以不用 Sparkle：安装包和更新信息放在本仓库的 GitHub Releases 上，App 自己检查、下载、校验签名，提示「重启以更新」。仓库需要是公开的（App 下载时不带凭据）。

**发版只在维护者的 Mac 上做**：签名、公证、发布都由 `scripts/release-mac.sh` 在本机完成，密钥和证书不离开这台 Mac，CI 不参与。

## 谁负责什么

| 部分 | 负责什么 |
| --- | --- |
| App 内（`app/update.ts` 决定，`app/team/updates.tsx` 显示） | 打开 5 秒后检查一次，之后每小时一次，读 `https://github.com/Sailfishc/noop/releases/latest/download/latest.json`。有新版本就后台下载、校验，侧栏底部出现「重启以更新到 x」，重启由人来点。用户菜单里有「检查更新」，结果显示在同一个位置 |
| 发版脚本（`scripts/release-mac.sh`） | 打包、Developer ID 签名、公证、签名 OTA 代码包、写并签名 `latest.json`、用 `gh` 先以草稿上传再设为 latest |
| 密钥（`scripts/release-keys.sh`） | 在本机生成根密钥和发版密钥，放在 `~/.remi-release-keys`，不进仓库、不上 GitHub |
| GitHub Releases | 每个版本一个 Release（tag `v<版本>`），附件见下 |
| 苹果公证 | macOS 才会放行下载来的 App |

两种更新，App 自动选：

- **OTA 代码包**（`remi-<版本>.nshpkg`）：只改了 TSX 的版本，App 下载签名过的代码包，重启后生效，不用换整个 App。新包先「试运行」，启动就崩会自动退回上一版。
- **整个 App**（`remi-<版本>-macos-aarch64.tar.gz`）：升级了 NSH 运行时的版本，代码包跑不了，就下载整个签名公证过的 App，校验后替换并重启。

此外每个 Release 带 `remi-macos-arm64.zip`（第一次安装用）、`latest.json`、`latest.json.sig`、`sha256sums`。`releases/latest/download/latest.json` 总是指向最新 Release 里的那份；草稿和预发布（比如 CI 的 `nsh-<commit>`）App 看不到。

### 和 LoopMe 的对应

| LoopMe | Remi |
| --- | --- |
| Sparkle | `nsh/updater`（NSH 自带） |
| `appcast.xml` + EdDSA 签名 | `latest.json` + `latest.json.sig`，发版密钥签名 |
| 公钥放在已忽略的 `release.env`，没填就不开更新 | 公钥在 `~/.remi-release-keys`，发版脚本只写进临时副本里的 `nsh.json`；仓库里的 `app/nsh.json` 没有 `updater`，本地和 fork 的构建不会更新 |
| `release-mac.sh`：归档、签名、公证、appcast、`gh` 发布 | `release-mac.sh`：同样的步骤 |
| 改 `CURRENT_PROJECT_VERSION` | 改 `app/nsh.json` 的 `version` 和 `build` |
| 先草稿再设为 latest | 同样 |
| 安装前停掉 daemon | 不需要：机器守护进程不在 App 里，它自己跟着 `main` 更新（`src/setup.ts` 的 `selfUpdate`） |
| 「自动安装更新」开关 | 暂不做：重启始终由人来点 |

## 一次性准备

1. **更新密钥**（装好 `nsh`，见 README）：
   ```sh
   scripts/release-keys.sh
   ```
   在 `~/.remi-release-keys` 生成 `root.*`（根密钥，给发版密钥签证书）和 `release.*`（发版密钥，签每个版本）。**把整个目录离线备份**（密码管理器或加密 U 盘）。根私钥丢了，已装的 App 就收不到 OTA 代码包；发版密钥丢了，已装的 App 就收不到任何更新，只能手动重装。证书默认 730 天，快到期时跑 `scripts/release-keys.sh renew`。
2. **Developer ID 证书**：钥匙串里要有「Developer ID Application」证书（`security find-identity -v -p codesigning` 能看到）。
3. **公证凭据**：
   ```sh
   xcrun notarytool store-credentials remi-notary --apple-id <Apple ID> --team-id <Team ID>
   ```
4. **GitHub CLI**：`brew install gh && gh auth login`，账号要能在本仓库发 Release。
5. 新建仓库根目录的 `release.env`（已在 `.gitignore`）：
   ```sh
   SIGN_IDENTITY="Developer ID Application: <名字> (<Team ID>)"
   NOTARY_PROFILE=remi-notary
   ```

## 发一个版本

1. 在 `app/nsh.json` 里把 `build` 加 1（OTA 代码包按它比较新旧，只增不减），`version` 改成新版本号（整个 App 按它比较）。提交并推到 GitHub。
2. 运行：
   ```sh
   RELEASE_NOTES="修复了……" scripts/release-mac.sh
   ```
   只想检查打包、签名和公证：`DRY_RUN=1 scripts/release-mac.sh`，产物在 `.nsh/release/feed`。
3. 脚本要求工作区干净、当前提交已推送，tag `v<版本>` 建在这个提交上。
4. 第一次安装：
   ```sh
   curl -fsSL https://raw.githubusercontent.com/Sailfishc/noop/main/install-client.sh | bash
   ```
   或者从 Release 页面下载 `remi-macos-arm64.zip`，解压后拖进「应用程序」。之后每台 Mac 一小时内收到更新，也可以在用户菜单点「检查更新」。

## 注意

- 本仓库的「最新 Release」必须是客户端版本。发别的 Release 时不要勾 latest（CI 的 `nsh-<commit>` 已经是预发布）。
- **第一个带更新的版本要手动装一次**：之前自己构建的 App 没有 `updater`（或者信任的是上游 noop 的密钥），收不到更新。
- 签名加了 hardened runtime，权限只开了麦克风（听写），见 `scripts/remi.entitlements`。如果某个功能在签名版里不能用，先看这里。
- 暂时只发 Mac（Apple 芯片）。Linux、Windows、手机先不发，`install-client.sh` 在 Linux 上会下载失败。
- 不进仓库：`~/.remi-release-keys`、`release.env`、公证凭据。别人 fork 了仓库也发不了更新给你的用户：没有你的发版密钥，`latest.json` 的签名对不上，App 会拒绝。
