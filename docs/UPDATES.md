# 应用更新与正式发布

PC 版从本仓库的 `updates/stable.json` 检查正式版本。Android 使用独立仓库和独立更新清单，不共享安装文件、版本号或用户数据。

## 用户如何收到更新

带更新功能的版本会在启动后检查新版，用户也可在设置中手动检查。发现新版后展示版本和更新说明，由用户选择下载；下载完成且 SHA-256、大小校验通过后，用户再选择退出并安装。检查或下载失败不会退出应用，可以稍后重试，也可从发布页手动下载安装包。PC 更新不会在听歌时自行重启。

已经安装的 0.4.9 及更早版本没有这项功能，需要先手动覆盖安装一次带更新功能的正式版本。此后正式发布新版本才会在应用中提示。源码中的新功能没有发布成安装包之前，不代表已安装用户获得了功能。

GitHub Raw、Release 下载在用户网络中不可达时，应用会显示失败，用户可以手动重试或打开发布页。单独提交代码、修改 README、推送 main，均不会通知客户端；只有正式发布安装包并成功推进稳定清单才会发现新版。维护者在 GitHub 页面上传最终安装包并点击正式发布，也会自动触发附件校验和清单推进，不需要再手改 JSON。

## 首次启用 Actions

- 保留默认分支 `main`，启用仓库 Actions。
- `.github/workflows/release.yml` 需要 `contents: write`；仓库／组织政策须允许 workflow 的 `GITHUB_TOKEN` 创建 Release 和更新 `main/updates/stable.json`。若 main 有阻止机器人直接写入的保护规则，应由维护者配置合适的发布权限。工作流会保留已公开安装包并报告失败，不绕过保护规则。
- PC 现有安装包未配置 Windows 代码签名，本工作流沿用现状。`GITHUB_TOKEN` 由 Actions 自动提供，当前 PC 发布不需要私钥 secrets。未来配置代码签名时单独调整现有打包配置和 CI。

## 每次发布

1. 在 PC 仓库更新 `package.json`、`package-lock.json` 中的版本，补充同版本 `CHANGELOG.md` 章节；使用无前导零的 `X.Y.Z` 正式版本。不要移动或重用公开标签。
2. 运行无依赖的 `node scripts/check-release-lock.mjs`，核对版本及官方 npm 下载地址，再用 `npm ci --registry=https://registry.npmjs.org` 安装锁定依赖。完成 `npm run typecheck`、`npm test`、`npm run build` 及有关原生／界面验收。发布流程会重新运行业务测试、发布保护测试和生产打包；CI 不会替代真实安装、升级和设备验收。
3. 提交、推送源码，为该提交建立并推送 `pc-vX.Y.Z` 标签。例如发布 0.4.12 时：

   ```sh
   git tag pc-v0.4.12
   git push origin pc-v0.4.12
   ```

4. Actions 在 `npm ci` 后显式执行 `node node_modules/electron/install.js`，安装锁定版本的官方运行时（Electron 44.6.0 不再通过 npm postinstall 自动下载）。在 Windows x64 上只构建 NSIS 安装器 `Yuyin-X.Y.Z-Setup.exe`。它先创建草稿、只上传一个安装文件，核对 GitHub 附件大小并重新下载校验 SHA-256；随后公开 Release，最后更新 main 的清单。`latest.yml`、`.blockmap`、便携包、许可压缩包和本地校验文件不会作为发布附件。
5. 检查 Actions 成功、发布页、清单，以及在隔离用户数据目录中的旧版升级体验。不要让客户端清单指向草稿、缺失附件或还未验收的文件。

若上传后清单写入失败，Release 可能已公开，但客户端尚未收到更新。先处理权限／网络问题。重新运行流程时，若已公开附件与本轮构建不一致，脚本会拒绝替换；维护者应使用原始已发布文件执行发布重试，或递增版本重新发布。公开版本及附件保持不可变。

已有草稿或公开版本的恢复使用工作流的 `workflow_dispatch`，填写与 main 源码版本一致的 `pc-vX.Y.Z` 标签。修复发布脚本后，可同时更新 `.github/workflows/release.yml`，该文件推送至 main 时也会自动尝试恢复当前版本已有的 Release；普通源码提交不会触发发布。恢复任务从 main 读取最新发布脚本，校验原标签的 package／lock 版本和唯一附件，下载原文件并核对 SHA-256，再使用 `--existing-only` 公开草稿或推进清单。它不构建、不上传文件，也不移动标签；不存在 Release 或安装附件时停止。安装包构建提交继续记录原标签提交，不能使用恢复提交代替。工作流通过非保留环境变量 `YUYIN_BUILD_COMMIT` 传入原标签提交，并在命令中显式使用 `--build-commit`；脚本会要求它是完整哈希且与标签解析到的提交一致，不能用恢复运行的 `GITHUB_SHA` 冒充构建来源。

如果只需修正已公开 Release 正文中错误的构建来源，必须同时使用 `--existing-only --correct-build-source --build-commit <标签提交>`（或设置 `YUYIN_BUILD_COMMIT`）。校正前会重新下载并核对唯一安装文件的 SHA-256；正文必须恰好包含一条有效的“实际构建提交”记录。校正只替换这一行，保留 CRLF、标题、其他正文、发布时间、标签和附件；缺失、重复、非法记录或任一回读字段改变都会停止，`--correct-build-source` 默认关闭。

## 从 GitHub 页面发布已有安装包

本机已经构建并验收的安装包，也可在对应 `pc-vX.Y.Z` 标签下准备草稿，只上传 `Yuyin-X.Y.Z-Setup.exe`，再点击 Publish release。必须是正式发布，不能标为 prerelease。发布标签的源码须包含当前工作流、发布脚本及匹配的版本来源。

`release.published` 事件执行独立 `advance-existing-release` job：检出该标签，校验 package／lock 版本，下载唯一最终安装包，复核公开状态、唯一附件、SHA-256 和大小，然后推进 main 的清单。它使用发布页现有文件，不重新构建、不替换附件。

同一次发布只选一种构建来源。手工上传本机最终文件时，发布源码提交可使用 GitHub 标准 `[skip ci]` 标记，让 tag push 跳过自动构建，避免两个不同构建抢占相同版本。这不影响 `release.published` 校验流程。首次更新桥接版本 0.4.10 采用本机验收后的最终产物和该标记，已于 2026-10-08 正式发布。

自动 tag 构建使用 `GITHUB_TOKEN` 创建 Release 时，GitHub 不会递归触发 `release.published` workflow；原 tag 工作流的发布脚本会自己推进清单。人工发布或既有本机发布入口则由发布事件校验，两条路径都保留一个最终安装附件。手工和事件工作流同时写入同版本相同文件时可以幂等收敛，不改变已公开内容。

## 本地预览与发布重试

现有产物可以生成预览清单，不连接 GitHub、不修改稳定通道：

```sh
node --test scripts/release.test.mjs scripts/release-cli.test.mjs scripts/check-release-lock.test.mjs
node scripts/release.mjs --validate-version --tag pc-v0.4.9
node scripts/release.mjs --dry-run --tag pc-v0.4.9 --artifact release/Yuyin-0.4.9-Setup.exe --output .qa/update-manifest-preview.json
```

将命令中的版本与文件替换成实际待发布版本。`--notes <文本文件>` 可提供经过核对的说明；默认提取 `CHANGELOG.md` 的同版本章节。`--current-manifest <文件>` 仅供 dry run 使用。预览输出不要覆盖 `updates/stable.json`。

正式模式是 `--publish`，需要 GitHub CLI `gh` 和具有本仓库内容写入权限的 `GH_TOKEN`／`GITHUB_TOKEN`，默认不执行发布。用于上传已验收的最终安装文件，或在清单写入失败后使用原文件重试。使用对应标签的源码运行：

```sh
node scripts/release.mjs --publish --tag pc-vX.Y.Z --artifact release/Yuyin-X.Y.Z-Setup.exe
```

只恢复已上传文件时附加 `--existing-only`；该模式拒绝不存在的 Release 和缺失安装附件，禁止创建 Release 或上传文件。草稿按标签查询为 404 时，会分页查找同标签并按 Release ID 回读。草稿阶段允许 GitHub 同仓库的临时 `untagged-*` 下载地址，正式公开后仍要求固定版本地址。

不要用重新构建的不同文件覆盖同版本正式附件。脚本会拒绝错平台、错标签、非唯一安装附件、版本回退、同版本替换和无效校验值；清单写入使用 GitHub 文件 SHA 防止并发覆盖。

## 清单契约

```json
{
  "schemaVersion": 1,
  "platform": "windows",
  "version": "0.4.9",
  "artifact": {
    "url": "https://github.com/panda472328/yuyin-music/releases/download/pc-v0.4.9/Yuyin-0.4.9-Setup.exe",
    "sha256": "d2531d5f8ab088a09898a98dd55db30767d5e9e54e772b1f6fefee7997e34a11",
    "size": 113801921
  },
  "releaseNotesUrl": "https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.9",
  "notes": "同版本更新说明",
  "publishedAt": "2026-10-08T10:01:51.000Z"
}
```

下载地址和说明地址只允许本平台仓库、相同版本的固定 GitHub 路径；版本每段最多六位，说明最多 8000 字，Windows 文件大小最多 500,000,000 字节。SHA-256 为小写 64 位十六进制，时间为 UTC ISO 格式。清单不含账号、Cookie、个人音乐库或私钥，安装时保留原应用身份及数据目录。

上面的契约示例描述历史 0.4.9 文件，不重新发布或修改该附件，也不会给相同版本显示新版本。首次带更新功能的正式包为 [0.4.10](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.10)；当前稳定通道以 main 的 `updates/stable.json` 为准。
