# 余音 Yuyin Music · Windows

一个基于 Electron、React 和 TypeScript 的 Windows 音乐播放器。米白与鼠尾草绿的独立听歌界面，音源来自后台浏览器中的 Bilibili 原视频。

当前 PC 功能版本为 **0.4.12**，包含安装保护、游客入口、双模式搜索和选曲从头播放，详见 [版本记录](CHANGELOG.md)。最终安装文件和公开状态以 [GitHub Releases](https://github.com/panda472328/yuyin-music/releases/latest) 为准。Android 版在[独立仓库](https://github.com/panda472328/yuyin-music-mobile)维护，两端具有统一视觉风格，分别构建、存储数据和发布版本。

## 下载与安装

前往 [GitHub Releases](https://github.com/panda472328/yuyin-music/releases/latest) 下载：

| 文件 | 用途 |
| --- | --- |
| `Yuyin-0.4.12-Setup.exe` | Windows x64 安装版，中文向导，可选择安装目录 |

发布页只提供一个最终安装文件 `Yuyin-0.4.12-Setup.exe`。安装修复与本轮功能一起合并到正式版本，不另发补丁或修复包。SHA-256 和构建来源直接写在发布说明中，许可文本见 [第三方声明](THIRD_PARTY_NOTICES.md)。GitHub 自动生成的 Source code ZIP / TAR 是源码下载入口。

安装前先正常关闭正在运行的余音。安装版默认安装到当前用户，提供桌面、开始菜单快捷方式和卸载入口；使用发布包无需安装 Node.js。当前 Windows 发布包没有数字签名，系统可能显示未知发布者提示。具体文件和校验值以该版本发布页为准。

遇到“余音无法关闭”或无法写入 `Uninstall 余音.exe` 时，先中止安装，正常退出余音与旧安装／卸载窗口；不要点“忽略”。将安装包移出程序目录，优先使用当前用户默认目录，必要时重启 Windows 后完整重装。原因、权限选择和修复边界见 [安装与重装](docs/INSTALLATION.md)。

首次进入可在 Bilibili 官方窗口完成登录，已有本机会话可继续使用，也可选择“暂不登录，先听歌”：游客可搜索、播放和管理本地收藏；导入账号收藏夹仍需登录。游客选择只在本次运行内有效，重开后再次提供登录／跳过入口。安装版、便携版与开发版默认共用本机数据目录；标准卸载保留数据，再次安装可继续使用。数据不会自动同步到其他电脑或 Android 版。

0.4.10 起支持自动检查正式新版，由用户选择下载和安装。0.4.9 及更早版本需要先手动覆盖安装一次当前正式版；提交代码不会直接更新已安装软件。维护者的 GitHub Actions 配置和标签发布步骤见 [更新与发布](docs/UPDATES.md)。

## 功能

- 两种搜索模式：默认歌名搜索，按完整输入匹配视频标题，不追加联想关键词；视频搜索保留 Bilibili 官方综合排序及全部视频结果，适合播客。选择在本机保存；搜索后手动播放。
- 后台原视频播放、暂停、跳转、上一首／下一首、音量、静音、系统媒体按键和睡眠定时。选曲和同曲重播从头开始，暂停继续保留当前位置。
- 列表循环、单曲循环、随机播放及队列管理。
- 收藏、歌单、最近播放历史，音乐库 JSON 导出与合并恢复。
- Bilibili 账号登录校验、头像菜单和账号收藏夹导入歌单。
- 默认 Bilibili 视频字幕，可切换 LRCLIB 搜索歌词；同步高亮、自动滚动、点击跳转和逐曲时间校准。
- 独立透明置顶桌面歌词，支持字体、字号、颜色、透明度、拖动与锁定。
- 收藏、歌单、播放偏好、歌词来源与校准、窗口和桌面歌词设置在本机保存。

## 音源与歌词

余音通过独立后台浏览窗口加载 Bilibili 原网页的 HTML5 播放器，不提取音频地址，也不提供音频下载或离线播放。后台仍会加载视频数据，画质可在源视频窗口调整。前台音乐界面不加载 Bilibili 的远程脚本；关闭整个播放器会结束后台播放。

搜索和播放受源站登录、验证、地区、会员、版权及视频可用性限制。遇到验证时在官方来源窗口完成操作后重试。项目与 Bilibili、LRCLIB 无隶属关系；源站内容与歌词不因本项目的开源许可获得再分发授权。

默认字幕来自当前视频首 P 已提供给原站会话的字幕，优先中文并标明 AI 自动字幕或 UP 主字幕。项目不会要求 Bilibili 生成新字幕，也未自行实现语音识别；没有字幕的视频可改选搜索歌词。

[LRCLIB](https://lrclib.net/) 提供按歌名、歌手与版本匹配的歌词。录音版本与 MV 片头可能造成固定偏移，可在听到一句开始时点「校准歌词」再点该句。正偏移表示延后，负偏移表示提前；搜索歌词以 0.5 秒微调，Bilibili 字幕以 0.1 秒微调，按视频和来源独立保存。现场、变速或中途剪辑造成的节奏差异无法仅靠一个偏移持续对齐。普通文字歌词没有逐句时间，不提供同步跳转或校准。

桌面歌词使用主界面当前来源与校准结果，不会再次查询歌词。工具栏在指针进入时显示、离开后约 2.2 秒隐藏；歌词、曲名、空白及左侧手柄可拖动，锁定后仍能使用设置按钮。现有字体使用系统字体，缺少时采用备用字体。

## 数据保存

默认数据目录是 `%APPDATA%/YuyinMusic`，与安装路径无关：

| 文件 | 内容 |
| --- | --- |
| `library.json` | 收藏、歌单、历史、队列、音量、播放模式及搜索模式 |
| `preferences.json` | 歌词来源、缓存与长期校准、静音前音量、睡眠定时、主窗口状态 |
| `desktop-lyrics.json` | 桌面歌词开关、锁定、字体、字号、颜色、透明度与位置 |

写入经过校验，采用临时文件替换并保留有效 `.bak` 备份；读取损坏时尝试有效备份，读取失败不会用默认空库覆盖原文件。音乐库 JSON 导出只覆盖音乐库，不包括另两个设置文件、浏览会话或音视频。Bilibili 浏览会话保存在本机 Electron profile 中，请勿提交 profile、登录信息或个人音乐库。

## 本地开发

需要 Node.js **22.12 或更新版本**、npm，以及 Windows 环境进行 Windows 包的完整验证。

```sh
npm ci
node node_modules/electron/install.js
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

网页预览使用浏览器本地存储，无法替代 Electron 后台播放、官方登录或桌面歌词窗口。开发和验收需使用隔离数据；详见 [贡献指南](CONTRIBUTING.md) 的 `--user-data-dir` 用法。

Windows 打包：

```sh
npm run dist
# 仅安装版：npm run dist:installer
# 仅便携版：npm run dist:portable
```

产物输出到 `release/`，文件名使用 `package.json` 的版本号。源码改动后需先完成类型检查和生产构建；`scripts/package-with-runtime.cjs` 是已有构建的补充打包工具，其 `--prepackaged` 模式不会重新编译源码。Electron 44.6.0 不再通过 npm postinstall 自动下载运行时；干净安装依赖后执行上述 `node node_modules/electron/install.js`，需要连接官方分发站点。运行时已完整安装时该命令可重复执行。

## 项目结构与样式修改

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/styles.css` | 主界面、页面、播放器、歌单及弹窗 |
| `src/theme.css` | 主界面的基础颜色变量 |
| `src/BilibiliAccount.tsx`、`src/BilibiliFavoritesDialog.tsx` | 登录引导、头像菜单与收藏夹导入界面 |
| `src/LyricsView.tsx`、`src/lyrics.css` | 主歌词页 |
| `src/DesktopLyrics.tsx`、`src/desktop-lyrics.css` | 独立桌面歌词界面 |
| `src/useLyrics.ts`、`src/useDesktopLyrics.ts` | 歌词状态、同步及桌面歌词发布 |
| `electron/` | 原生窗口、受限 IPC、后台原网页、网络服务与数据保存 |
| `tests/` | 业务、磁盘持久化、账号状态、歌词与播放竞态检查 |
| `docs/` | 样式标准、验证记录与贡献参考 |
| `build/`、`public/` | 打包图标与静态资源 |
| `out/`、`release/` | 本机生成的构建／发布产物，不提交到源码仓库 |

修改外观前阅读 [AGENTS.md](AGENTS.md) 和 [样式标准](docs/STYLE-GUIDE.md)。标准包含颜色、字体、组件选择器、窗口拖动规则、添加主题／字体步骤，以及 PC 与手机独立样式同步方法。

## 验证范围

0.4.12 的 TypeScript 检查、生产构建、149 项业务测试、6 类播放器竞态和 5 组归零回归通过。隔离 Electron 中完成游客、搜索模式及保存检查，两种窗口尺寸已检查；13 项原生 NSIS 保护测试与本地安装器占用时提前退出检查通过。完整首次安装、旧版覆盖升级与真实跨用户 UAC 尚未在独立 Windows 环境验收。受控响应检查与真实 Bilibili 播放分别记录，不能相互替代；歌词时间高亮检查不代表已对真实歌声做听觉比对。

详细结果及未执行项见 [docs/QA.md](docs/QA.md)。Bilibili 页面与接口会变化，其他电脑和账号的可用性需要实际验证。

## 贡献与许可

欢迎通过 [Issues](https://github.com/panda472328/yuyin-music/issues) 反馈问题或提交 Pull Request。请说明 PC／Android 平台、版本与复现步骤，避免附带个人账号信息。开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

发布文件与版本管理见 [发布说明](docs/RELEASE.md)。本项目源码采用 [MIT License](LICENSE)，依赖和外部内容的归属见 [第三方声明](THIRD_PARTY_NOTICES.md)。依赖、系统字体、Bilibili 内容与外部歌词仍适用各自许可或服务规则。
