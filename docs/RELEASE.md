# 发布与文件管理

PC 与 Android 使用独立仓库、版本、依赖和构建产物。PC 源码位于本仓库；Android 源码位于 [yuyin-music-mobile](https://github.com/panda472328/yuyin-music-mobile)。不要把其中一个工程嵌套进另一个仓库。

## PC 0.5.1（openmusic，2026-10-12 正式发布）

[GitHub 正式发布页](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.5.1) 已公开，唯一安装附件为 [Yuyin-0.5.1-Setup.exe](https://github.com/panda472328/yuyin-music/releases/download/pc-v0.5.1/Yuyin-0.5.1-Setup.exe)。本版新增当前视频评论区和 MV 入口，展示品牌改为 openmusic，并加入 Gitee／GitHub 双源更新器；继续使用 WPF、自包含 .NET 与系统 WebView2，沿用 0.5.0 的安装身份和本地数据目录。安装前先正常退出播放器，升级不会自动迁移旧 Electron 数据或删除旧“余音”快捷方式。完整许可见 [MIT](../LICENSE) 和 [第三方声明](../THIRD_PARTY_NOTICES.md)。

| 项目 | 值 |
| --- | --- |
| 安装包实际构建及标签提交 | `d00992dccec11f9600d51f69c74f699cf3dd56ac` |
| 安装包 SHA-256 | `2384bb10c85a14ca16d36e99fff93a580b6df66dfebd7a636b2f107ee8225138` |
| 安装包字节数 | `54274254` |
| GitHub Release／唯一附件 ID | `410142763`／`632599293` |
| 正式发布时间（UTC） | `2026-10-12T03:59:01Z` |
| GitHub 稳定清单更新提交 | `041dc0438b6ea613f4e6a61ac57e84d7c07e199d` |

[正式标签 Actions 38201688304](https://github.com/panda472328/yuyin-music/actions/runs/38201688304) 整体成功，完成测试、WebView2 安装文件构建、安装保护、备份和正式发布。发布器在 Windows runner 完整下载并核验唯一附件的大小及 SHA-256，公开后推进 `updates/stable.json` 至 0.5.1；清单版本、文件地址、摘要、大小和时间与公开附件一致。后续文档整理不会移动标签或重建、替换该安装文件。

本版隔离回归通过 173 项 TypeScript 业务测试、287 项宿主契约检查（含 136 项更新检查）、34 项受控原生媒体检查、22 项 WebView2 页面检查、26 项 MV 脚本检查、11 项安装保护／受控流程检查、83 项发布工具检查和 7 组国内清单准备检查。评论写入使用受控响应，真实账号评论发送和源站网页全屏兼容性尚未完整验收；原生媒体检查不能替代真实音源的听觉验收。完整安装、跨机器及已安装客户端的更新生命周期限制仍见 [QA.md](QA.md) 与 [INSTALLATION.md](INSTALLATION.md)。

国内通道状态：待发布与核验。[Gitee 0.5.1 预定发布入口](https://gitee.com/openmusic/openmusic/releases/tag/pc-v0.5.1) 尚不作为可用下载证明；须在正式附件公开、匿名完整下载与 SHA-256／大小一致、公开国内清单验证通过后，补记 Gitee Release／附件 ID 及验收证据。目前正式下载和稳定通道的已确认发布证据为上述 GitHub 记录。

## PC 0.5.0（WebView2，2026-10-11 正式发布）

[正式发布页](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.5.0) 已公开，唯一安装附件为 [Yuyin-0.5.0-Setup.exe](https://github.com/panda472328/yuyin-music/releases/download/pc-v0.5.0/Yuyin-0.5.0-Setup.exe)。默认 `npm run dist:installer` 构建 React renderer、自包含 .NET WPF 宿主和单个安装 EXE，只使用系统 WebView2，不分发 Electron／Chromium。运行时缺失时使用微软官方联网引导安装器。`electron/` 历史宿主代码保留在源码中供参考，不进入新包；发行许可文本见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

| 项目 | 值 |
| --- | --- |
| 安装包实际构建及标签提交 | `fe1f0af48ff6fd4c07c70ec706d9673d8c53ee0b` |
| 安装包 SHA-256 | `4c8708594d01b5e5448e88c73b154322db39489b7841aa26e287fa9890b407cb` |
| 安装包字节数 | `54235650` |
| Release／唯一附件 ID | `409608262`／`630500807` |
| 正式发布时间（UTC） | `2026-10-11T10:55:00Z` |
| 稳定清单更新提交 | `4c620738cd425f8f48df28284c45ca39d58fc4ac` |

[正式标签 Actions 38133373433](https://github.com/panda472328/yuyin-music/actions/runs/38133373433) 整体成功，完成依赖和版本检查、应用／宿主测试、WebView2 安装包构建、原生安装保护、备份及正式发布。发布器上传唯一安装文件，在 Windows runner 完整下载并校验 SHA-256 和大小，公开 Release 后才推进 main 的 `updates/stable.json`；清单的版本、固定下载地址、大小、摘要和发布时间均与公开附件一致。后续文档提交不移动标签，也不重建或替换这一安装文件。

桌面歌词的真实 WPF/WebView2 原生检查已通过正文拖动、位置写盘、字号按钮和工具栏隐藏／重新显示；锁定后禁止拖动、设置重启恢复及其他尚未完整验收的范围见 [QA.md](QA.md)。公开元数据与云端下载校验不等于真实安装、跨机器或在线音源验收。

## PC 0.4.12

安装保护与游客／双模式搜索／选曲归零功能合并到同一个正常版本。[正式发布页](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.12) 已公开，最终文件仅为 [Yuyin-0.4.12-Setup.exe](https://github.com/panda472328/yuyin-music/releases/download/pc-v0.4.12/Yuyin-0.4.12-Setup.exe)。没有另发修复包或替换历史 0.4.10 附件。

| 项目 | 值 |
| --- | --- |
| 安装包实际构建及标签提交 | `fe77e18c33213aed781f0f975262ced188a22c24` |
| 安装包 SHA-256 | `bf283a54a8b1edc5b11f93a97cc99dca320a6d89460797d01f24a093f7d4f595` |
| 安装包字节数 | `113804727` |
| Release／唯一附件 ID | `408835383`／`627533277` |
| 正式发布时间（UTC） | `2026-10-10T09:55:56Z` |
| 稳定清单更新提交 | `e6e3bd96783283b7305e026ce48b9f0755d08bb2` |

[原始标签构建](https://github.com/panda472328/yuyin-music/actions/runs/38041004910) 通过测试和打包，上传原始附件后在最终发布步骤失败。[恢复任务](https://github.com/panda472328/yuyin-music/actions/runs/38043092213) 复用原始 Release 和附件，在 Windows runner 完整下载并复核 SHA-256、大小后公开并推进 main 稳定清单；没有重新构建、上传或移动标签。[来源校正任务](https://github.com/panda472328/yuyin-music/actions/runs/38044820075) 再次下载并校验同一附件，只修正公开正文中的构建提交来源；构建和稳定推进 job 按预期跳过。原始工作流不能整体记为成功。

发布前生成的本地 0.4.11 文件仅为测试产物，其校验值不代表 Actions 最终文件。本机公开元数据核对和云端完整下载校验已经完成；完整首次安装、旧版覆盖升级和跨用户权限尚未在独立 Windows 环境验收，详情见 [QA.md](QA.md) 与 [INSTALLATION.md](INSTALLATION.md)。

## PC 0.4.11（未发布）

标签 `pc-v0.4.11` 保留在提交 `eefecff5cb1319386e49516e244cf07739dee279`，不移动或复用。[首次 Actions 构建](https://github.com/panda472328/yuyin-music/actions/runs/38038571637) 在安装依赖时因锁文件中的非法版本 `0.4.03` 失败，没有创建正式 Release 或公开安装文件，也没有推进稳定清单。锁文件从官方源重建，Electron 保持 44.6.0，相关功能改由 0.4.12 正式发布。

## PC 0.4.10

正式版本：[pc-v0.4.10](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.10)，唯一安装文件为 `Yuyin-0.4.10-Setup.exe`。从这一版本开始，安装版支持检查、下载并由用户确认安装后续更新。旧版先手动覆盖安装一次；此后通过正式发布与稳定清单发现新版。校验值和实际构建提交写在发布说明中。

本轮采用已在本机验收的安装包进行首次发布，发布源码提交使用 GitHub 标准 `[skip ci]` 标记，避免标签构建另一个同版本文件。源码与运行机制检查见 [QA.md](QA.md)，GitHub 正式发布后的稳定通道流程见 [UPDATES.md](UPDATES.md)。

| 项目 | 值 |
| --- | --- |
| 安装包实际构建及标签提交 | `18649bbb4cdf11ced8cd9251e577c0db5b36e973` |
| 安装包 SHA-256 | `8edd5f60113fa73f56ee82e8ea8363dd43bba37f9e6dc8bfe776bdf7c76a636a` |
| 安装包字节数 | `113809571` |
| 正式发布时间（UTC） | `2026-10-08T15:15:58Z` |

后续验证文档和稳定清单提交只推进 main，不移动已发布标签，也不重建或替换这一安装文件。

## PC 0.4.9（历史）

公开发布页：[pc-v0.4.9](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.9)。

| 内容 | 文件 |
| --- | --- |
| Windows x64 安装包 | `Yuyin-0.4.9-Setup.exe` |

每个平台的发布页仅保留一个最终安装文件。PC 使用安装版 EXE；校验值、文件大小和源码来源写在发布说明中，完整许可通过 [第三方声明](../THIRD_PARTY_NOTICES.md) 查阅，不再作为下载页的独立附件。GitHub 自动生成的 Source code ZIP / TAR 是源码入口。

本机公开产物整理在 `release/published/pc-v0.4.9/`；原安装包、便携包、校验和构建记录保留在本机供追溯。二进制、依赖、缓存和 `.qa/` 不提交到源码仓库；第三方许可属于需要保留的文档。

本次采用已验证的 0.4.9 安装包，实际构建源码为 `01b76bff9ee7e1f8b7d06459de6e6f4cbf71ffea`，文件大小为 113,801,921 字节，SHA-256 为 `d2531d5f8ab088a09898a98dd55db30767d5e9e54e772b1f6fefee7997e34a11`。安装器的完整生命周期与正式包验证见 [QA.md](QA.md)。公开标签 `pc-v0.4.9` 指向开源整理提交 `54c188e671e44d8e73c75ebc0f5e6b028ee14b60`，后续发布页精简文档在 main 更新，不移动标签。功能代码和安装包保持 0.4.9。

## 后续发布

新发布流程见 [UPDATES.md](UPDATES.md)：推送与源码版本一致的 `pc-vX.Y.Z` 标签后，Actions 构建并发布唯一 NSIS 安装附件，完成下载复核后推进客户端稳定清单。下列人工整理原则继续适用；不重新发布或替换历史 0.4.9 附件。

1. 在 PC 仓库检查工作目录、现有 diff 和版本；在 `package.json` 与锁文件同步递增版本并更新 CHANGELOG。
2. 完成与改动有关的检查。代码改动执行 `npm run typecheck`、`npm test`、`npm run build`；样式按 [STYLE-GUIDE.md](STYLE-GUIDE.md) 验证，纯文档改动核对事实与链接。
3. 从干净提交构建最终安装器，保留必要的第三方声明；在隔离数据目录验收对应包，核对实际版本和来源。便携版可在本机按需构建。
4. 将该版本安装包复制到独立版本目录，生成本机校验与来源记录；在发布说明写明 SHA-256、字节数、实际构建提交和源码标签，链接仓库中的完整许可文本。
5. 给发布源码建立 `pc-v<版本>` 标签。先准备草稿 Release，只上传一个最终安装版 EXE，核对文件与说明后发布。已公开标签和本机来源记录保留用于追溯；需要精简附件时保持原安装文件及版本不变。

SHA-256 只用于核对下载内容；当前 PC EXE 尚未做 Windows 代码签名。签名、登录 Cookie 和用户音乐库不进 Git，也不作为 Release 附件。
