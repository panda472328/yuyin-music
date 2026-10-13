# 应用更新与正式发布

PC 版通过本仓库的 GitHub `updates/stable.json` 和 Gitee `updates/domestic.json` 检查正式版本。当前两份清单为 **0.5.2**；[GitHub 正式发布页](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.5.2) 和 [Gitee 正式发布页](https://gitee.com/openmusic/openmusic/releases/tag/pc-v0.5.2) 的唯一安装包已公开。Android 使用独立仓库和独立更新清单，不共享安装文件、版本号或用户数据。

0.5.3 当前仅为待发布源码：展示名称与快捷方式改为 `open音乐`，下次安装按实际目标替换同安装的已知旧快捷方式，见 [INSTALLATION.md](INSTALLATION.md)。Gitee／GitHub 地址、更新 schema、应用安装身份与 `Yuyin-X.Y.Z-Setup.exe` 文件名保持兼容；未公开最终附件并完成校验前不推进更新清单。

## 国内更新通道（0.5.2 已启用）

0.5.2 的 Gitee 正式 Release／唯一附件 ID 为 `1200021`／`3371613`，文件为 `Yuyin-0.5.2-Setup.exe`，大小 `54264043` 字节，SHA-256 为 `12b818df22cc804faaf1295f5774a84a8cb24c0577ea5edf760a3bfe228a0d6c`。[候选准备 Actions 38247735370](https://github.com/panda472328/yuyin-music/actions/runs/38247735370) 与本机匿名准备脚本均完整下载并核验上述附件；本机候选严格审核与 GitHub stable 一致后，以提交 `a94c428` 保存 `updates/domestic.json` 并推送两个远程。[国内清单／原生探针 Actions 38249178605](https://github.com/panda472328/yuyin-music/actions/runs/38249178605) 已成功复核候选元数据并运行原生 Gitee 探针。本机实际原生 Gitee 更新探针已通过：实际 `UpdateService` 选择 Gitee，匿名完整下载并两次核验同一大小与 SHA-256，输出 `Public native Gitee probe passed`，退出码为 0。国内通道已启用；探针未启动安装器，不代表实际已安装客户端完整升级通过。

0.5.1 起 WebView2 客户端同时检查 Gitee 的固定公开 Contents API `https://gitee.com/api/v5/repos/openmusic/openmusic/contents/updates/domestic.json?ref=main` 与现有 GitHub `stable.json`，各源有独立 12 秒预算。Gitee 响应仅接收 `type=file`、`encoding=base64`、`name=domestic.json`、`path=updates/domestic.json` 的文件封装，外层最多 128 KiB、解码后的清单最多 64 KiB；校验大小、规范 Base64 与有效 UTF-8 后再解析清单，不使用封装里的 `download_url` 或其他地址。选择有效清单中的较新版本；同版本且大小、SHA-256 一致时优先 Gitee。一个源缺失、超时或格式不合法时可以使用另一个有效源；同版本字节校验值冲突则停止更新。已安装版本不会降级，同一宿主会话内也不会因镜像落后丢失已经验证的较新版提示，或接受同版本替换文件。安装仍须用户点击，检查过程不下载安装包、不自动重启。

国内清单使用独立 schema 2，不覆盖 GitHub schema 1 的 `updates/stable.json`。旧客户端继续从 GitHub 升级；需要先安装一次含双源更新器的新版本，建议使用已修正附件路径兼容的 0.5.2，才能使用国内通道。历史准备记录：2026-10-12 发布前匿名读取 Gitee `openmusic/openmusic` 的 Releases API 返回空数组，当时尚无正式附件或 domestic 清单；该观察不代表目前公开状态。

同日发布前的历史匿名实测：网页 Raw 文件地址会 302 跳转到带短期签名的 `raw.giteeusercontent.com`，而官方 `/raw/{path}` API 对这个公开仓库返回 401。固定 Contents API 读取已存在的 `updates/stable.json` 为 200、Base64 文件响应，当时缺失的 `updates/domestic.json` 为 200 + `[]`；准备脚本仅将空数组或 404 视为尚无清单，其余错误拒绝推进。客户端将缺失或不合法的国内响应作为不可用源，继续检查 GitHub；无需使用用户账号或令牌。

国内安装地址仅采用 [Gitee 官方 API 文档](https://gitee.com/api/v5/swagger_doc) 的 `GET /api/v5/repos/openmusic/openmusic/releases/{release_id}/attach_files/{attach_file_id}/download`，Release／附件 ID 必须为正整数，文件名称仍保留兼容值 `Yuyin-X.Y.Z-Setup.exe`。清单只保存固定 API，不保存签名 CDN 地址、个人令牌、Cookie 或账号凭据。

2026-10-12 匿名实测官方公开项目 `cxasm/notepad--` 的发行版 `248632`／附件 `1177556`：该文档下载 API 返回一次 302，目标为 `https://foruda.gitee.com/attach_file/<正整数>/<原附件文件名>`；查询恰有 `token`（32 位小写十六进制短期下载签名）、`ts`（10 位 Unix 秒）和 `attname`（原文件名），后续匿名响应为 200，声明大小与附件 API 一致，没有再次跳转。本次只检查公开元数据及响应头并取消正文，不把它计为本项目安装包完整校验。

客户端和准备脚本据此只接受本仓库固定附件 API 发出的一次 `foruda.gitee.com` HTTPS 跳转，数字路径后缀和路径中的文件名（文件名比较不区分大小写）必须对应当前版本的 `Yuyin-X.Y.Z-Setup.exe`，而 `attname` 必须逐字匹配该文件名；只允许上述三个字段及已观测格式，禁止额外查询、账号凭据、非标准端口、片段和第二次 CDN 跳转。清单请求不能使用附件 CDN。签名只在本次请求内存中使用，不写日志或清单；每次显式重试重新从固定 API 取得签名。未知 CDN、跨版本或其他查询一律拒绝。如果国内附件返回错误、签名过期、大小／摘要不符、断网或超时，客户端删除本次临时文件，再按相同版本、大小和 SHA-256 下载固定 GitHub 正式附件。备用文件也必须完成全部校验，不能回退到旧版本安装包。Gitee 普通仓库当前[单附件上限为 100 MB，总附件上限为 1 GB](https://help.gitee.com/repository/release/create)，发布时仍须以实际上传及匿名完整下载为准。

### 每次准备 Gitee 国内发布

1. 完成现有 GitHub 正式发布和稳定清单推进，保留一个最终安装附件。Gitee 创建相同 `pc-vX.Y.Z` 正式 Release，只上传该 GitHub 已公开文件的同一份字节；不重新构建、不替换旧版附件、不上传另一个修复包。官方 API 文档定义了 `POST .../releases/{release_id}/attach_files`（multipart 的 `file` 字段），但本仓库当前的准备脚本不会调用上传接口，也不读取个人令牌。
2. 运行以下只读准备命令。它匿名读取两端公开清单、Gitee 对应标签与唯一附件元数据，再通过官方固定 API 及上述受限的一次 Foruda 跳转完整下载附件，复核文件名、大小和 SHA-256，最后回读 Release／附件身份及远端通道。仅当字节与 GitHub 已公开文件一致、版本不回退且同版本附件不替换时才写本地候选。未知 CDN 或第二次跳转会停止生成，不从页面 HTML 或任意 `browser_download_url` 推测；签名过期后重新运行脚本获取新签名。

   ```sh
   node --test scripts/prepare-domestic-update.test.mjs
   node scripts/prepare-domestic-update.mjs --prepare --output .qa/domestic-candidate.json
   ```

3. 审核候选后将其保存为 `updates/domestic.json`，提交并推送源码到 GitHub 和 Gitee；保留 `stable.json` 中的固定 GitHub 地址。发布前在绝对临时 `YUYIN_STATE_DIR`／`YUYIN_WEBVIEW2_USER_DATA_DIR` 下完成实际 Gitee 清单、完整附件、备用下载与用户选择安装验收。不要在 Gitee 附件未公开或完整下载未通过时推进 domestic 清单。

本机公共 API 限流时，可使用 GitHub Actions 的 `Verify public Gitee update channel` 工作流从独立网络执行相同匿名准备脚本。该工作流只在本仓库 `main` 上运行，权限为 `contents: read`；不会上传安装包或修改清单，仅保存已验证的候选 JSON 七天。没有 `updates/domestic.json` 时只生成候选，明确不声称原生探针通过；清单提交后会再次生成候选、核对版本和附件身份，再运行下面的原生下载探针。0.5.2 已由 Actions 38249178605 完成这套独立复核并成功。公共 API 限流、下载或摘要校验失败都会使工作流失败，不能当作国内通道已通过。

公开清单与附件准备完成后，可以显式运行宿主的只下载验收：`dotnet run --project tests/windows-host/Yuyin.HostTests.csproj -c Release -- --live-update-probe X.Y.Z`（`X.Y.Z` 替换为正式版本；本机也可使用 `.tools/dotnet/dotnet.exe`）。该操作使用实际 `UpdateService`、受控旧版本 `0.5.0` 和新建临时缓存，要求选择 Gitee 并匿名完整下载、两次检查大小及 SHA-256；GitHub 回退不计为国内通过。不启动应用、不读取 profile、不调用安装接口，完成后只删除本次随机缓存。它不能代替用户选择安装及实际升级验收。

国内清单比旧契约增加 `schemaVersion: 2`、`provider: "gitee"` 和 `source: { "releaseId": 12345, "attachmentId": 67890, "filename": "Yuyin-X.Y.Z-Setup.exe" }`。ID 例子仅说明结构；必须使用正式 Gitee Release API 回读的真实身份。artifact 的 URL 固定为上述同仓库附件下载 API，releaseNotesUrl 固定为同版本 `https://gitee.com/openmusic/openmusic/releases/tag/pc-vX.Y.Z`；其余版本、字节数、SHA-256、说明和发布时间沿用已校验的 GitHub 稳定清单。

0.5.2 的类型检查与完整回归已由正式发布流程重新验证，本机宿主受控回归另通过 138 项更新检查，线上附件的匿名候选下载和实际原生只下载探针均已通过，命令与结果见 [QA.md](QA.md)。历史 0.5.1 的 Contents API 与 Foruda 修正后，国内准备脚本 7 组回归及实际原生更新器 136 项受控检查通过，覆盖 Base64 文件封装、路径／分支固定、空数组缺失、受限单次 CDN 跳转、签名过期后的新请求、大小／摘要、来源冲突、版本回退、未知跳转、国内响应正文中断后备用下载，以及磁盘错误不触发网络备用；没有启动真实安装器或读取真实用户 profile。

以下说明当前 GitHub 稳定通道，并保留 0.5.0 的历史发布证据和旧客户端流程。

## 当前 GitHub 稳定通道

0.5.2 的 [正式标签 Actions 38206256264](https://github.com/panda472328/yuyin-music/actions/runs/38206256264) 成功完成构建、发布及下载校验，再以提交 `4ffca3e6f81c7aa96448aebdb470be274a9e133a` 推进 main 的稳定清单。当前 GitHub 清单指向 `Yuyin-0.5.2-Setup.exe`，大小为 `54264043` 字节，SHA-256 为 `12b818df22cc804faaf1295f5774a84a8cb24c0577ea5edf760a3bfe228a0d6c`；实际构建提交为 `c07be63cb6c933da50f0d76c3185f312b41e7a46`，Release／附件 ID 为 `410191409`／`632727070`。完整构建与公开证据见 [RELEASE.md](RELEASE.md)。实际已安装 0.5.x 的应用内下载安装尚未完整验收，清单推进不等于这一用户流程已通过。

历史 0.5.0 的 [正式标签 Actions 38133373433](https://github.com/panda472328/yuyin-music/actions/runs/38133373433) 已成功完成构建、发布及下载校验，再以提交 `4c620738cd425f8f48df28284c45ca39d58fc4ac` 推进当时 main 的稳定清单。该版文件为 `Yuyin-0.5.0-Setup.exe`，大小为 `54235650` 字节，SHA-256 为 `4c8708594d01b5e5448e88c73b154322db39489b7841aa26e287fa9890b407cb`；此记录不用于校验当前版本。

0.5.0 起原生更新器是 `windows-host/UpdateService.cs`。安装器写入 `installed.marker`；开发／未安装的发布目录可检查新版，但不启动安装。检查、下载、安装采用同一稳定清单契约，下载安装仍由用户选择。安装程序等待当前宿主自然退出后写入文件，不强杀进程。此次架构迁移不提供旧 Electron 客户端数据或会话自动迁移；请使用新版独立安装目录。

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
2. 运行无依赖的 `node scripts/check-release-lock.mjs`，核对版本及官方 npm 下载地址，再用 `npm ci --registry=https://registry.npmjs.org` 安装锁定依赖。使用 `actions/setup-dotnet 8` 后完成 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:host` 和 `npm run test:host-native`，并完成有关原生／界面验收。发布流程会重新运行这些检查、发布保护测试和生产打包；CI 不会替代真实安装、升级和设备验收。
3. 提交、推送源码，为该提交建立并推送 `pc-vX.Y.Z` 标签。例如发布 0.4.12 时：

   ```sh
   git tag pc-v0.4.12
   git push origin pc-v0.4.12
   ```

4. Windows runner 使用 `actions/setup-dotnet 8`，在 x64 上执行 `npm run dist:installer -- --x64 --publish never`，只构建 NSIS 安装器 `Yuyin-X.Y.Z-Setup.exe`。通过 `npm run test:installer` 原生保护检查后，先将唯一安装包作为 Actions artifact 备份 7 天；缺少文件会停止，备份不出现在公开 Release 附件列表中。随后创建草稿、只上传一个安装文件，核对 GitHub 附件大小并重新下载校验 SHA-256；再公开 Release，最后更新 main 的清单。`latest.yml`、`.blockmap`、便携包、许可压缩包和本地校验文件不会作为发布附件。
5. 检查 Actions 成功、发布页、清单，以及在隔离用户数据目录中的旧版升级体验。不要让客户端清单指向草稿、缺失附件或还未验收的文件。

若上传后清单写入失败，Release 可能已公开，但客户端尚未收到更新。先检查工作流中的退出码与脱敏错误原因，判断是权限、API、网络还是发布状态问题，不能只凭客户端更新失败归因于用户网络。日志会屏蔽令牌、Authorization 与下载 URL 的凭据、查询参数和片段；不要为了诊断输出凭据。正式发布失败时，保留并核对原构建和 Actions 安装包备份。重新运行流程时，若已公开附件与本轮构建不一致，脚本会拒绝替换；维护者应使用原始已发布文件执行发布重试，或递增版本重新发布。公开版本及附件保持不可变。

恢复任务开始前会运行只读发布诊断：仅使用 Actions 临时令牌的 `actions: read`，读取当前版本标签、原构建提交对应的最新失败标签运行，并要求唯一失败步骤是最终 Publish。诊断只在 warning 和 Step Summary 输出限长的错误行，隐藏令牌、认证头和所有日志 URL，不上传原始日志。诊断失败不会阻断恢复。受控测试入口为 `node --test scripts/diagnose-release-failure.test.mjs`。

已有草稿或公开版本的恢复使用工作流的 `workflow_dispatch`，填写与 main 源码版本一致的 `pc-vX.Y.Z` 标签。修复发布脚本后，可同时更新 `.github/workflows/release.yml`，该文件推送至 main 时也会自动尝试恢复当前版本已有的 Release；普通源码提交不会触发发布。恢复任务从 main 读取最新发布脚本，校验原标签的 package／lock 版本和唯一附件，下载原文件并核对 SHA-256，再使用 `--existing-only` 公开草稿或推进清单。它不构建、不上传文件，也不移动标签；不存在 Release 或安装附件时停止。安装包构建提交继续记录原标签提交，不能使用恢复提交代替。工作流通过非保留环境变量 `YUYIN_BUILD_COMMIT` 传入原标签提交，并在命令中显式使用 `--build-commit`；脚本会要求它是完整哈希且与标签解析到的提交一致，不能用恢复运行的 `GITHUB_SHA` 冒充构建来源。

如果只需修正已公开 Release 正文中错误的构建来源，必须同时使用 `--existing-only --correct-build-source --build-commit <标签提交>`（或设置 `YUYIN_BUILD_COMMIT`）。校正前会重新下载并核对唯一安装文件的 SHA-256；正文必须恰好包含一条有效的“实际构建提交”记录。校正只替换这一行，保留 CRLF、标题、其他正文、发布时间、标签和附件；缺失、重复、非法记录或任一回读字段改变都会停止，`--correct-build-source` 默认关闭。

## 从 GitHub 页面发布已有安装包

0.4.14 的首次发布在创建草稿后的回读校验处停止，安装包未上传。该版本增加一次固定来源的恢复入口：只有 `pc-v0.4.14` 和原构建提交 `023bec8ae0e7c3ccb4d5ca9667245313e8ef54e2` 无 Release 或只有空草稿时，才从原 Actions run `38109329998`、attempt 1、artifact `11691332289` 取回备份。恢复器核对原构建、原生安装保护、备份成功与唯一发布失败，再校验固定 ZIP 大小和 SHA-256，提取根目录唯一最终 EXE，计算 EXE 自身摘要，并从原标签读取版本和说明。备份 ZIP 的摘要不能当作 EXE 摘要。此入口不重新构建；其他版本仍要求已有唯一安装附件。

新建草稿前会读取远端现有标签，解析 annotated tag 并核对实际构建提交。创建使用 GitHub API 返回的 Release ID 回读，避免立即依赖标签或列表查找；之后仍须下载复核安装包、正式公开，再推进稳定通道。回读、上传或校验失败会停止，不能替换公开同版本附件。

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
