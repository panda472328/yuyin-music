# 第三方组件与内容声明

本项目原创代码采用根目录 [MIT 许可证](LICENSE)。以下组件、服务内容和各自的版权声明继续适用其原有许可；项目的 MIT 许可证不替代第三方许可。

## Windows 运行时与安装包

PC 0.5.0 使用 Microsoft.Web.WebView2 SDK 1.0.4258.31、.NET 8 与 WPF，以及下表中的 React／Lucide／NSIS。WebView2 SDK 适用微软 SDK 许可；.NET 运行时和 WPF 使用其 MIT 许可及 THIRD-PARTY-NOTICES。构建从实际 NuGet 依赖复制原始许可到安装目录 `licenses/`。系统 WebView2 Evergreen Runtime 和微软引导安装器适用微软条款；运行时不随应用重新分发。历史 Electron 和 Chromium 声明继续保留供旧版参考，不表示新版携带这些组件。

以下是 PC 0.4.12 使用的主要发行组件，与 0.4.9 的组件版本一致。版本以该版本的 `package-lock.json` 和正式 Electron 运行时为准。

| 组件 | 版本 | 许可与原始文本 | 上游项目 |
| --- | --- | --- | --- |
| React | 19.3.0 | MIT；[原始许可证](licenses/React-LICENSE.txt) | [facebook/react](https://github.com/facebook/react) |
| React DOM | 19.3.0 | MIT；[原始许可证](licenses/ReactDOM-LICENSE.txt) | [facebook/react](https://github.com/facebook/react) |
| scheduler | 0.28.0 | MIT；[原始许可证](licenses/Scheduler-LICENSE.txt) | [React scheduler](https://github.com/facebook/react/tree/main/packages/scheduler) |
| Lucide React | 0.468.0 | ISC；[原始许可证及 Feather 归属](licenses/Lucide-LICENSE.txt) | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |
| Electron | 44.6.0 | MIT；[原始许可证](licenses/Electron-LICENSE.txt) | [electron/electron](https://github.com/electron/electron) |
| Chromium、Node.js、V8、FFmpeg 及 Electron 所带其他组件 | 随 Electron 44.6.0 | 各组件的原许可；完整文本见下文 | [Electron 许可](https://github.com/electron/electron/blob/main/LICENSE)、[Chromium](https://chromium.googlesource.com/chromium/src/) |
| NSIS 安装及便携封装组件 | electron-builder 使用的 3.0.4.1 发行版 | zlib/libpng、bzip2、CPL 1.0 及其 LZMA 链接例外；[完整原始 COPYING](licenses/NSIS-COPYING.txt) | [NSIS](https://nsis.sourceforge.io/)、[源码下载](https://nsis.sourceforge.io/Download)、[electron-builder binaries](https://github.com/electron-userland/electron-builder-binaries) |

`licenses/` 中上述文本从本版本实际使用的依赖包复制，版权行与许可全文保持原样。Lucide 原许可中包含 Feather 的归属，不将其改为本项目作者的版权。

Electron 发行目录中包含 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。后者约 20 MB，收录 Chromium 及相关运行时组件的完整许可。本仓库的 [Electron 44.6.0 完整运行时许可压缩包](docs/runtime-licenses/Electron-44.6.0.zip) 原样保存这两份文件，其他组件的完整许可位于 `licenses/`。发行页仅保留最终安装器，通过发布说明链接本文件和上述原文。重新分发程序时应一并保留对应版本的完整许可证和声明；不能用此表代替原发行包的完整声明。

NSIS 的 COPYING 同时列出了其压缩组件的许可和 LZMA 链接例外。这里提供原始完整文本，不将项目原创代码改为 CPL，也不删改 NSIS 原作者的许可条件。上游源码入口见表中链接。

## WebView2 版本的运行组件

余音 0.5.0 的默认 Windows 安装包使用 .NET 8/WPF 和 Microsoft.Web.WebView2 SDK 1.0.4258.31，不包含 Electron、Chromium 或 Fixed Version WebView2 内核。默认自包含发行目录携带 .NET 运行时，发布脚本从实际 NuGet 依赖复制其原始 LICENSE、NOTICE 和 THIRD-PARTY-NOTICES 到发行目录的 `licenses/`；.NET 的 MIT 与第三方声明、Microsoft WebView2 SDK 的微软软件许可条款继续适用，不能由本项目 MIT 许可替代。构建版本以实际 `.csproj` 和 NuGet 解析结果为准。

桌面歌词的组合控件还使用 Microsoft.Windows.SDK.NET.Ref 10.0.17763.56 中的 Windows API 投影与 WinRT.Runtime。其 NuGet 元数据链接微软 Windows SDK 许可；[原始 SDK 许可](licenses/Microsoft-Windows-SDK-LICENSE.rtf) 来自 [Microsoft 官方许可地址](https://aka.ms/WinSDKLicenseURL)，随发行文件保留。

安装器携带微软官方 Evergreen Bootstrapper（联网安装工具），构建时验证其 Microsoft Authenticode 签名；它不是 WebView2 内核。已安装的系统共享 Runtime 由微软更新，缺失时首次安装可能另行下载 Runtime；软件和运行时仍受微软相应许可条款约束。来源：[WebView2 官方下载](https://developer.microsoft.com/microsoft-edge/webview2/#download-section)、[WebView2 SDK NuGet](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31)、[.NET 许可](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT)。

## 构建与验证工具

TypeScript（Apache-2.0）、Vite（MIT）、electron-vite（MIT）、electron-builder（MIT）、esbuild（MIT）、tsx（MIT）和 Playwright（Apache-2.0）用于编译、打包或验证。它们与应用中的 React 和 Electron 运行时用途不同，开发依赖列表不意味着其完整工具包都被放入安装后的应用。

开发工具及其传递依赖仍按各自 npm 包内的 LICENSE / NOTICE 和锁文件管理。若复制或分发这些工具的代码或二进制，应同时提供对应工具自己的完整声明。NSIS 的安装器组件实际进入 Windows 发行封装，因此单独列在上面的发行组件表中。

## Bilibili、歌词与封面

- Bilibili 的名称、标志、网页、公开视频、音频、字幕、封面和账号数据由其平台或相应权利人管理。本项目不是 Bilibili 官方产品，MIT 不授予这些内容或商标的使用许可。
- `src/data/recommendations.json` 保存的是公开视频链接、标题、UP 主、时长、播放量和远程封面 URL，不包含视频或音频文件。页面在运行时显示的封面、以及 `docs/preview.png` 界面预览中出现的第三方封面，保留原权利人的权利，不作为本项目 MIT 授权的原创图像。
- 歌词来自 Bilibili 已有字幕或 [LRCLIB](https://lrclib.net/) 返回的歌词。服务端代码的开源许可与歌词文本的权利不同；本项目的 MIT 不重新许可歌曲、歌词或字幕。
- 第三方服务的可用性、登录与使用规则由各服务决定；获取内容仍需遵循适用的服务规则和权利要求。

## 更新规则

升级依赖或运行时后，同时核对 `package-lock.json`、实际发行组件及其原 LICENSE / NOTICE，更新本文件和 `licenses/`；更换 Electron 后从新的正式运行时复制完整 Electron / Chromium 声明到 `docs/runtime-licenses/` 对应版本的压缩包，并更新链接。现有许可文本不得通过全局替换版权名称或改为 MIT 的方式更新。
