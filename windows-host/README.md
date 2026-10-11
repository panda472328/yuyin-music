# openmusic Windows WebView2 宿主

openmusic（原名余音）从 0.5.0 起使用 WPF/.NET 8 承载现有 React 界面，音源页和桌面歌词分别运行在独立 WebView2 窗口中。发行文件不包含 Electron、Chromium 或 Fixed Version WebView2 Runtime；浏览器内核来自 Windows 上共享的 Microsoft Edge WebView2 Evergreen Runtime。

用户可见名称为小写 `openmusic`。为兼容已有安装与本地数据，宿主命名空间／程序集 `Yuyin.WindowsHost`、`YUYIN_*` 环境变量、`%LOCALAPPDATA%/YuyinMusic` 状态目录、安装／卸载标识和 `Yuyin-<版本>-Setup.exe` 发行文件名保持不变。已发布 0.5.0 附件及历史验证记录不因展示改名而改写。

## 宿主接口

React renderer 继续使用 `MusicAPI` 和 `DesktopLyricsAPI`。`src/webview2-bridge.ts` 与宿主的 `bridge.js` 提供请求、事件和同步本地存储适配；远程 Bilibili 页面不接入这些应用接口。

| 源文件 | 职责 |
| --- | --- |
| `MainWindow.xaml.cs` | 本地 renderer 来源和方法白名单、窗口控制、登录窗口、收藏夹与文件对话框、退出保存 |
| `BilibiliService.cs`、`BilibiliSubtitles.cs` | 使用本应用 WebView2 会话查询账号、官方双模式搜索、收藏夹、原视频字幕和 LRCLIB |
| `PlayerHost.cs` | 独立音源窗口、后台播放、归零与可信时钟、手动跳转、音量与结束事件 |
| `LocalDataStore.cs` | 音乐库、窗口和设置的校验写入、有效备份与损坏恢复 |
| `DesktopLyricsHost.cs` | 独立透明歌词 renderer、原生拖动与锁定、透明度、位置保存与工作区边界 |
| `UpdateService.cs` | 稳定更新清单、版本检查、按大小和 SHA-256 校验下载，用户选择后调用安装器 |

默认安装包包含 .NET/WPF 运行库、WebView2 SDK 适配库和 Windows SDK/WinRT API 投影，保证普通用户无需单独安装 .NET。它们不是浏览器内核；WebView2 Evergreen Runtime 由 Windows 上的共享安装提供。

## 构建条件

- Windows 10 1903（build 18362）／Windows 11 x64；桌面歌词的 WebView2CompositionControl 需要该系统下限，当前正式安装脚本只构建 x64。
- Node.js 22.12 或更新版，运行 `npm ci --registry=https://registry.npmjs.org`。
- .NET 8 SDK；只安装 .NET Runtime 不能编译项目。
- 构建单 EXE 安装器时需要网络，以下载微软官方 WebView2 Evergreen Bootstrapper 和 NSIS 构建工具。构建脚本要求 bootstrapper 的 Authenticode 签名有效且发布者为 Microsoft Corporation；不是把 WebView2 内核下载到发行文件中。

系统没有全局 SDK 时，可设置 `YUYIN_DOTNET_EXECUTABLE` 为 SDK 的 `dotnet.exe` 绝对路径。该变量只控制构建工具，应用运行不依赖它。

## 开发和发布命令

从仓库根目录执行：

```powershell
npm run build          # 两个 renderer + Release WPF 宿主编译
npm run dev            # 构建 renderer 后运行 Debug WebView2 宿主
npm run publish:webview2
npm start              # 运行刚发布的自包含宿主
npm run dist:installer
```

`build:webview2` 仅生成 `out/webview2-renderer/`。`publish:webview2` 默认以自包含 .NET 的方式输出 `release/webview2/win-x64-self-contained/`，其中包含 `Yuyin.WindowsHost.exe` 和旁边的 `renderer/`，无需用户另装 .NET。安装器为唯一 `release/Yuyin-<版本>-Setup.exe`；使用当前用户安装目录、桌面／开始菜单快捷方式和独立卸载登记。

可选的最小体积构建：

```powershell
npm run publish:webview2 -- --framework-dependent
```

该输出位于 `release/webview2/win-x64/`，用户必须先安装 .NET 8 Desktop Runtime。它用于体积对比或受控部署，不是默认安装包。`--runtime win-arm64` 可生成 ARM64 宿主目录，但当前 x64 安装器不封装它。

原 Electron 开发／构建／启动／打包入口保留为 `dev:electron`、`build:electron`、`start:electron` 和 `dist:electron`，便于比较迁移行为；默认发布命令不再使用 Electron 运行时。

## 系统 WebView2 前置条件

系统已安装 Evergreen Runtime 时，安装器复用它。缺失时，仅首次运行随包附带的小型官方 bootstrapper，联网下载并安装微软共享运行时；失败会明确停止，尚不覆盖 openmusic 程序文件。网络完全离线且系统无 Runtime 时，应先使用微软的 Evergreen Standalone Installer 安装运行时，再安装 openmusic。

应用启动还通过 `CoreWebView2Environment.GetAvailableBrowserVersionString()` 再次检测。运行时缺失时，窗口显示说明和微软官方下载入口；可以正常关闭窗口，安装 Runtime 后重新启动 openmusic。Windows 上安装了 Edge 浏览器不代表一定存在可用的 WebView2 Runtime。

官方下载：[Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/#download-section)。微软负责 Evergreen 内核更新；openmusic 的版本、源码和安装包更新仍由本项目维护。

## 隔离验收

验收不能使用真实用户的浏览会话、歌曲收藏、设置或账号。构建后在 PowerShell 创建新的绝对路径测试目录：

```powershell
$yuyinQaState = Join-Path $env:TEMP ('yuyin-webview2-qa-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $yuyinQaState | Out-Null
$env:YUYIN_STATE_DIR = $yuyinQaState
$env:YUYIN_WEBVIEW2_USER_DATA_DIR = Join-Path $yuyinQaState 'WebView2'
& '.\release\webview2\win-x64-self-contained\Yuyin.WindowsHost.exe'
```

同一测试目录重启可验证保存。若直接 `dotnet run`，额外设置 `YUYIN_RENDERER_DIR` 为 `out/webview2-renderer/` 的绝对路径。三个变量不得指向真实用户目录；相对路径不作为隔离状态目录。默认状态目录为 `%LOCALAPPDATA%/YuyinMusic`，浏览器会话在其 `WebView2/` 子目录中；卸载不清除此目录。

```powershell
npm run typecheck
npm run build
npm test
npm run test:host
npm run test:host-native
$env:YUYIN_REQUIRE_INSTALLER_TESTS = '1'
npm run test:installer
```

`test:host` 使用临时目录和受控响应验证持久化、Bilibili／歌词与更新契约；`test:host-native` 使用独立 WebView2 profile 和自制静音 WAV 验证真实媒体轴、后台推进及控制。版本号均来自 `package.json`。

安装保护测试实际编译并运行原生 NSIS 检查，验证无占用、缺失目标、独占锁和无关文件。流程测试只写唯一 QA 注册键和受控安装目录，测试卸载清除该登记，不创建真实快捷方式，不读写真实 profile。正式安装向导、真实快捷方式、缺失 Runtime 的联网引导、真实登录与听觉输出仍需在隔离 Windows 环境分别验收；本地证据不能代替这些在线或跨机器检查。具体已完成项以 `docs/QA.md` 记录为准。

## 原生边界和源码管理

`src/webview2-bridge.ts` 将现有 `MusicAPI`／`DesktopLyricsAPI` 映射到 `chrome.webview` 消息。宿主只接受受信任本地来源及白名单操作，参数必须校验；Bilibili 页面不接入本地应用桥接。新增 API 应同时更新 TypeScript 契约和 C# 校验，不能暴露任意文件路径、命令或脚本执行接口。

`bin/`、`obj/`、`out/`、`release/`、`.tools/`、WebView2 user data、临时安装工具和 `.qa/` 均为本地产物，不提交源码。发布脚本只允许替换带有其归属标记的专用输出目录，拒绝符号链接和非预期目录。不得移动已有发布标签或用本地产物替换公开的同版本安装包；新架构通过原生验收后，再发布新的版本标签和唯一安装文件。
