# 参与余音 PC 版

本仓库是 Windows 桌面端，当前源码版本为 0.5.0（WPF + 系统 WebView2），正式安装文件以 [GitHub Releases](https://github.com/panda472328/yuyin-music/releases/latest) 为准。Android 的问题和修改请提交到 [yuyin-music-mobile](https://github.com/panda472328/yuyin-music-mobile)。两个仓库使用独立版本、构建与数据，不把手机源码或 APK 放进 PC 仓库。

## 开发流程

1. Fork／克隆项目，在清晰命名的分支开发，例如 `style/lyrics-spacing` 或 `fix/library-save`。
2. 安装 Node.js 22.12 或更新版、.NET 8 SDK 和系统 WebView2，在根目录运行 `npm ci --registry=https://registry.npmjs.org`。构建新版无需下载 Electron；`electron/` 保留历史宿主参考与共享契约。
3. 阅读 [AGENTS.md](AGENTS.md)。涉及界面时先看 [STYLE-GUIDE.md](docs/STYLE-GUIDE.md)，定位选择器与最终 CSS 覆盖。
4. 保持改动聚焦，复用现有组件、类型和样式语义。依赖或配置变化须同步 `package-lock.json`，不要手工改生成文件来代替源代码。
5. 运行与改动相符的验证，提交 Pull Request，说明问题、行为变化、测试结果和未验证范围。

## 隔离测试数据

开发版默认与正式版共用 `%LOCALAPPDATA%/YuyinMusic`。测试收藏、登录、窗口保存时，使用独立状态目录与 WebView2 profile，不使用维护者或用户的真实数据。

构建后在 Windows PowerShell 启动隔离实例：

```powershell
npm run build
$yuyinQaProfile = Join-Path $env:TEMP ('yuyin-pc-qa-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $yuyinQaProfile | Out-Null
$env:YUYIN_STATE_DIR = Join-Path $yuyinQaProfile 'state'
$env:YUYIN_WEBVIEW2_USER_DATA_DIR = Join-Path $yuyinQaProfile 'webview2'
npm run dev
```

两个环境变量必须是绝对路径，非法路径会被拒绝，避免误用真实目录。重启同一个测试目录可验收保存效果。测试完成后先关闭全部测试进程，仅清理自己创建且已核对路径的测试目录。0.5.0 的后台播放、登录窗口和桌面歌词必须使用实际 WPF + WebView2 宿主；`npm run dev:web` 只用于网页预览。

网页预览可用 `npm run dev:web`，后台播放／原生拖动使用实际 WPF + WebView2。不要读、导出或提交 cookies、真实 profile、真实音乐库、密码、令牌或私钥。问题报告中使用虚构曲目、脱敏错误信息和没有个人信息的截图。

## 验证

```sh
npm run typecheck
npm run build
npm test
npm run test:host
npm run test:host-native
```

纯视觉改动运行类型检查和生产构建，然后按样式标准完成相关页面与状态的视觉检查；无需为低风险颜色或间距调整编写复刻实现的测试。改变业务、存储或 IPC 时运行 `npm test`，并补充能验证实际风险的回归。已有人工记录和清单在 [docs/QA.md](docs/QA.md)，未执行项不能写为通过。

修改安装行为时编辑 `build/webview2-installer.nsi`，不修改依赖中的 NSIS 模板。打包后运行 `npm run test:installer`，验证原生占用与受控安装生命周期。完整注册项、快捷方式及覆盖升级在独立 Windows 环境验收；`test:installer` 通过不等于完成真实安装验收。详见 [安装与重装](docs/INSTALLATION.md)。

提交界面改动时附 1440×950 与 1080×680 下的相关截图，说明 hover、focus、disabled、loading、error 等状态。若改桌面歌词，补充浅／深背景、长歌词、显示／隐藏工具栏、锁定／解锁及实际命中检查；浏览器中的 CSS 断言不能证明 Windows 原生拖动可用。

## 版本与发布

- PC 功能版本以 `package.json` 为准，标签格式 `pc-vX.Y.Z`；主界面目前存在版本文案，升级时一起搜索更新。
- 文档整理不强制增加功能版本，发布说明应区分程序变化与公开文档整理。
- `npm run dist` 生成单个 WebView2 安装版，产物在 `release/`。GitHub Release 仅发布一个最终安装 EXE，校验值和来源写在说明，完整许可链接源码文档；源码不提交 EXE、`out/`、`bin/`、`obj/`、`node_modules/` 或本地验收目录。
- 发布页说明平台、版本、文件用途、校验值和验证限制；仅测试过受控响应时，不声明真实网络播放全部通过。
- Android 使用其独立仓库、版本号和 `android-vX.Y.Z` 公开发布标签，保留早期 `mobile-v` 历史。修改共同品牌时按照样式标准分别实现与验证。
- 自动发布及稳定通道见 [docs/UPDATES.md](docs/UPDATES.md)。`pc-vX.Y.Z` 标签触发 Actions，最终安装包公开并复核后才写入 `updates/stable.json`；普通 main 提交不通知客户端。改发布工具时运行 `node --test scripts/release.test.mjs` 和对应产物的 `--dry-run`。

## 许可

本项目采用 [MIT License](LICENSE)。提交贡献即表示你有权提供相关代码／资源，并同意以项目许可发布。引入字体、图片或第三方资源时记录来源与许可，不把系统字体或源站音视频作为本项目资源提交。
