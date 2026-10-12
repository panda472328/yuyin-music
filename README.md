# openmusic · Windows

一个基于 WPF、系统 WebView2、React 和 TypeScript 的 Windows 音乐播放器。米白与鼠尾草绿的独立听歌界面，音源来自后台浏览器中的 Bilibili 原视频。0.5.0 起安装包不再携带 Electron／Chromium 内核。

项目现名为 **openmusic**（原名余音 / Yuyin Music）。当前源码的界面、窗口和安装向导使用新名称；已发布的 0.5.0 安装包及其校验记录保留原名。为兼容已有安装、收藏、设置和更新，数据目录、技术标识、源码仓库地址及安装包文件名仍保留原来的 `Yuyin`／`yuyin` 值；改名不迁移或清空用户数据。手机版仍在独立仓库，本次仅修改 PC 版。

后续使用改名后的安装包升级时，会创建 openmusic 名称的快捷方式。旧「余音」快捷方式不会自动删除，以免影响独立安装的旧 Electron 版；确认旧快捷方式已不再使用后，可自行清理。

当前正式版本为 **0.5.0**，已迁移到 Windows 系统 WebView2，保留游客入口、双模式搜索、歌词及本地音乐库；详见 [版本记录](CHANGELOG.md)。[正式发布页](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.5.0) 已公开，稳定清单已推进至 0.5.0。Android 版在[独立仓库](https://github.com/panda472328/yuyin-music-mobile)维护，两端分别构建、存储数据和发布版本。

## 下载与安装

前往 [GitHub Releases](https://github.com/panda472328/yuyin-music/releases/latest) 下载正式版，0.5.0 只提供下列安装文件：

| 0.5.0 正式文件 | 用途 |
| --- | --- |
| [Yuyin-0.5.0-Setup.exe](https://github.com/panda472328/yuyin-music/releases/download/pc-v0.5.0/Yuyin-0.5.0-Setup.exe) | Windows x64 安装版，中文向导，可选择安装目录 |

正式安装包为 **54,235,650 字节（约 54.2 MB）**，由 [Windows Actions 38133373433](https://github.com/panda472328/yuyin-music/actions/runs/38133373433) 从 `pc-v0.5.0` 构建并发布。SHA-256、实际构建提交和稳定清单证据见 [发布与文件管理](docs/RELEASE.md)，许可文本见 [第三方声明](THIRD_PARTY_NOTICES.md)。GitHub 自动生成的 Source code ZIP / TAR 是源码下载入口。

支持 Windows 10 1903（build 18362）及 Windows 11 x64。安装包包含 .NET 运行文件，使用系统 Microsoft Edge WebView2 Evergreen Runtime；若系统缺少 WebView2，安装器通过微软官方小型引导程序联网安装共享运行时，不把内核装进每份应用。此架构版本使用新数据目录，不自动读取旧 Electron 客户端资料。

安装前先正常关闭正在运行的 openmusic（旧版显示余音）。安装版默认安装到当前用户，提供桌面、开始菜单快捷方式和卸载入口；使用发布包无需安装 Node.js。当前 Windows 发布包没有数字签名，系统可能显示未知发布者提示。具体文件和校验值以该版本发布页为准。

旧安装包遇到“余音无法关闭”或无法写入 `Uninstall 余音.exe` 时，先中止安装，正常退出播放器与旧安装／卸载窗口；不要点“忽略”。将安装包移出程序目录，优先使用当前用户默认目录，必要时重启 Windows 后完整重装。原因、权限选择和修复边界见 [安装与重装](docs/INSTALLATION.md)。

首次进入可在 Bilibili 官方窗口完成登录，已有新版会话可继续使用，也可选择“暂不登录，先听歌”：游客可搜索、播放和管理本地收藏；导入账号收藏夹仍需登录。游客选择只在本次运行内有效，重开后再次提供登录／跳过入口。0.5.0 安装版与开发版默认共用新版数据目录；标准卸载保留数据，再次安装可继续使用。数据不会自动同步到其他电脑或 Android 版。

0.4.10 起支持自动检查正式新版，由用户选择下载和安装。0.4.9 及更早版本需要先手动覆盖安装一次当前正式版；提交代码不会直接更新已安装软件。维护者的 GitHub Actions 配置和标签发布步骤见 [更新与发布](docs/UPDATES.md)。0.5.0 是新宿主架构，旧 Electron 客户端不会自动迁移数据或会话。

## 功能

- 两种搜索模式：默认歌名搜索使用 Bilibili 官方输入联想，允许部分歌名、歌名加歌手或版本词；沿官方页码召回并保留全部结果，每页及已加载合并结果按标题相关性稳定排序，同分沿官方页／项顺序。视频搜索保持 Bilibili 官方视频排序，适合播客。联想、选择候选和搜索只更新结果，不自动播放；搜索模式在本机保存。
- 后台原视频播放、暂停、跳转、上一首／下一首、音量、静音、系统媒体按键和睡眠定时。选曲和同曲重播从头开始；无用户操作的异常跳转恢复最近可信进度，暂停继续保留当前位置。
- 列表循环、单曲循环、随机播放及队列管理。
- 收藏、歌单、最近播放历史，音乐库 JSON 导出与合并恢复。
- Bilibili 账号登录校验、头像菜单和账号收藏夹导入歌单。
- 当前视频评论区（后续版本源码）：自动读取正在播放的视频，支持热门／最新、分页、楼中楼回复；游客可浏览，登录后可点赞、取消点赞、发表评论和回复。
- MV 入口（后续版本源码）：侧栏“Bilibili · MV”展示当前播放视频的网页全屏画面，复用后台播放器与当前进度；评论入口改到右下角气泡按钮。
- 默认 Bilibili 视频字幕，可切换 LRCLIB 搜索歌词；同步高亮、自动滚动、点击跳转和逐曲时间校准。
- 独立透明置顶桌面歌词，支持字体、字号、颜色、透明度、拖动与锁定。
- 收藏、歌单、播放偏好、歌词来源与校准、窗口和桌面歌词设置在本机保存。

## 音源与歌词

openmusic 通过独立后台浏览窗口加载 Bilibili 原网页的 HTML5 播放器，不提取音频地址，也不提供音频下载或离线播放。后台仍会加载视频数据，画质可在源视频窗口调整。前台音乐界面不加载 Bilibili 的远程脚本；关闭整个播放器会结束后台播放。

搜索和播放受源站登录、验证、地区、会员、版权及视频可用性限制。遇到验证时在官方来源窗口完成操作后重试。项目与 Bilibili、LRCLIB 无隶属关系；源站内容与歌词不因本项目的开源许可获得再分发授权。

评论入口在右下角播放器工具栏的气泡按钮，侧栏原位置改为“Bilibili · MV”。评论发送至 Bilibili 原视频，切换歌曲或账号会清除当前草稿和回复目标；发送失败保留输入。遇到超时或结果不确定，先打开源视频核对再决定是否重发。源站审核、风控、评论关闭等限制仍然有效；评论草稿和列表仅保留在当前页面会话，不写入音乐库。源码新增功能不代表已公开的 0.5.0 安装文件已更新。

MV 在同一个来源窗口内自动开启网页全屏，保留正在听的位置；按 Esc、关闭或最小化可返回后台继续播放。视频仍在加载、需要验证或网页全屏控件不可用时，保留普通来源窗口并提示重试。

默认字幕来自当前视频首 P 已提供给原站会话的字幕，优先中文并标明 AI 自动字幕或 UP 主字幕。项目不会要求 Bilibili 生成新字幕，也未自行实现语音识别；没有字幕的视频可改选搜索歌词。

[LRCLIB](https://lrclib.net/) 提供按歌名、歌手与版本匹配的歌词。录音版本与 MV 片头可能造成固定偏移，可在听到一句开始时点「校准歌词」再点该句。正偏移表示延后，负偏移表示提前；搜索歌词以 0.5 秒微调，Bilibili 字幕以 0.1 秒微调，按视频和来源独立保存。现场、变速或中途剪辑造成的节奏差异无法仅靠一个偏移持续对齐。普通文字歌词没有逐句时间，不提供同步跳转或校准。

桌面歌词使用主界面当前来源与校准结果，不会再次查询歌词。工具栏在指针进入时显示、离开后约 2.2 秒隐藏；歌词、曲名、空白及左侧手柄可拖动，锁定后仍能使用设置按钮。现有字体使用系统字体，缺少时采用备用字体。

## 数据保存

默认数据目录是 `%LOCALAPPDATA%/YuyinMusic`，与安装路径无关：

| 文件 | 内容 |
| --- | --- |
| `library.json` | 收藏、歌单、历史、队列、音量、播放模式及搜索模式 |
| `preferences.json` | 歌词来源、缓存与长期校准、静音前音量、睡眠定时、主窗口状态 |
| `desktop-lyrics.json` | 桌面歌词开关、锁定、字体、字号、颜色、透明度与位置 |

写入经过校验，采用临时文件替换并保留有效 `.bak` 备份；读取损坏时尝试有效备份，读取失败不会用默认空库覆盖原文件。音乐库 JSON 导出只覆盖音乐库，不包括另两个设置文件、浏览会话或音视频。Bilibili 会话保存在此目录下的 `WebView2/`，请勿提交 profile、登录信息或个人音乐库。

## 本地开发

需要 Windows、Node.js **22.12 或更新版本**、npm、.NET 8 SDK 和系统 WebView2。可用 `YUYIN_DOTNET_EXECUTABLE` 指定 SDK 的绝对路径。

```sh
npm ci
npm run dev
```

类型检查、测试与生产构建：

```sh
npm run typecheck
npm test
npm run build
```

启动已构建的桌面客户端：

```sh
npm start
```

仅预览前台界面：

```sh
npm run dev:web
```

网页预览使用浏览器本地存储，无法替代 WebView2 后台播放、官方登录或桌面歌词窗口。开发和验收需设置绝对路径的 `YUYIN_STATE_DIR` 和 `YUYIN_WEBVIEW2_USER_DATA_DIR`；详见 [贡献指南](CONTRIBUTING.md)。

Windows 打包：

```sh
npm run dist
# 仅安装版：npm run dist:installer
```

产物输出到 `release/`，文件名使用 `package.json` 的版本号。`npm run dist:installer` 构建前端、自包含 .NET 宿主和单个 NSIS 安装 EXE。`electron/` 与 `*:electron` 命令保留为历史参考，不进入 WebView2 安装包；旧 `dist:portable` 仍属于历史 Electron 路线。

## 项目结构与样式修改

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/styles.css` | 主界面、页面、播放器、歌单及弹窗 |
| `src/theme.css` | 主界面的基础颜色变量 |
| `src/BilibiliAccount.tsx`、`src/BilibiliFavoritesDialog.tsx` | 登录引导、头像菜单与收藏夹导入界面 |
| `src/LyricsView.tsx`、`src/lyrics.css` | 主歌词页 |
| `src/DesktopLyrics.tsx`、`src/desktop-lyrics.css` | 独立桌面歌词界面 |
| `src/useLyrics.ts`、`src/useDesktopLyrics.ts` | 歌词状态、同步及桌面歌词发布 |
| `windows-host/` | WPF 原生窗口、受限消息桥、后台原网页、网络服务与文件保存 |
| `src/webview2-bridge.ts` | 前端与 Windows 宿主 API 适配 |
| `electron/` | 历史宿主参考及共享类型，不进入新版安装包 |
| `tests/` | 业务、磁盘持久化、账号状态、歌词与播放竞态检查 |
| `docs/` | 样式标准、验证记录与贡献参考 |
| `build/`、`public/` | 打包图标与静态资源 |
| `out/`、`release/` | 本机生成的构建／发布产物，不提交到源码仓库 |

修改外观前阅读 [AGENTS.md](AGENTS.md) 和 [样式标准](docs/STYLE-GUIDE.md)。标准包含颜色、字体、组件选择器、窗口拖动规则、添加主题／字体步骤，以及 PC 与手机独立样式同步方法。

## 验证范围

0.5.0 的 WebView2 宿主、受控媒体时钟、存储／歌词／更新契约、生产构建和安装保护已有隔离回归记录；宿主契约检查通过 159 项，前端／业务回归记录为 160 项 TypeScript 测试，受控原生媒体检查通过 21 项，WebView2 页面检查 22 项，当前安装器保护检查通过 11 项，发布／锁文件检查通过 61 项，锁文件元数据检查覆盖 435 个包。正式标签的 Actions 流程已成功完成测试、最终构建、安装保护、公开附件下载校验和稳定清单推进。之前的 0.4.x Electron 检查保留在 [docs/QA.md](docs/QA.md) 的历史章节，不代表新宿主已通过同一项验收。

桌面歌词已在真实 WPF/WebView2 窗口通过歌词正文拖动、位置写盘、字号按钮、工具栏隐藏与重新显示检查；锁定后禁止拖动和设置重启恢复仍未完整验收。字体／颜色／透明度控件、两个规定尺寸的完整原生页面状态、正式安装向导、桌面／开始菜单快捷方式、卸载、缺失 WebView2 Runtime 的联网引导、真实 Bilibili 登录／音源、跨机器 UAC，以及实际已安装 0.5.x 的应用内更新也尚未完整验收。网页预览和受控响应不能替代这些检查。

详细结果及未执行项见 [docs/QA.md](docs/QA.md)。Bilibili 页面与接口会变化，其他电脑和账号的可用性需要实际验证。

## 贡献与许可

欢迎通过 [Issues](https://github.com/panda472328/yuyin-music/issues) 反馈问题或提交 Pull Request。请说明 PC／Android 平台、版本与复现步骤，避免附带个人账号信息。开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

发布文件与版本管理见 [发布说明](docs/RELEASE.md)。本项目源码采用 [MIT License](LICENSE)，依赖和外部内容的归属见 [第三方声明](THIRD_PARTY_NOTICES.md)。依赖、系统字体、Bilibili 内容与外部歌词仍适用各自许可或服务规则。
