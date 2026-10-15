# PC 0.5.4 发布验证

日期：2026-10-15。保留经典与系统明暗，发布新版 Bilibili / 我的世界主题、主题预览和主窗 / 桌面歌词各自独立的四款歌词预设；带本地 Fusion Pixel 字体及完整许可。源码 UI 同步记录见 [QA-UI-SYNC-20261015.md](QA-UI-SYNC-20261015.md)。

## 最终文件

| 项目 | 值 |
| --- | --- |
| 唯一安装附件 | `Yuyin-0.5.4-Setup.exe` |
| 实际构建与不可变标签提交 | `c24044310746ed3677c8926c7cb7f27d6b895b47` |
| 干净构建记录 | `dirty=false` |
| 字节数 | `54919198` |
| SHA-256 | `2799486dd0b9cd9d4ee2c5893f557ac4c62ba06d023aad6f317a26800654b4e3` |
| 宿主 ProductVersion | `0.5.4+c24044310746ed3677c8926c7cb7f27d6b895b47` |

安装包继续使用系统 WebView2 Evergreen Runtime，携带 .NET 运行文件与验证过微软签名的 WebView2 引导安装器，未捆绑浏览器内核。沿用安装身份、数据路径和 open音乐 快捷方式；没有 Windows 代码签名。GitHub / Gitee 发布身份及通道状态见 [RELEASE.md](RELEASE.md)。不把后续文档与清单提交描述为安装包构建来源。

## 本轮实际执行

| 检查 | 结果 |
| --- | --- |
| `npm run dist:installer` | 类型、renderer、WPF、自包含发布和最终安装器构建通过 |
| `scripts/check-release-lock.mjs` | 435 个包的官方 registry 锁文件检查通过 |
| `npm test` | 195 项业务测试、10 项竞态、8 组时钟、22 项来源及 26 项 MV 检查通过 |
| `npm run test:host` | 344 项通过：存储 23、Bilibili / 歌词 109、评论 51、更新器 138、桌面设置 23 |
| `npm run test:host-native` | 34 项受控实际 WPF / WebView2 媒体检查通过，使用绝对临时状态 / profile |
| `npm run test:installer` | 15 项受控安装器生命周期、占用及 Unicode 快捷方式检查通过 |
| 发布 / 国内候选保护测试 | 68 项通过 |
| 桌面歌词原生渲染 | 13 项通过：实际加载本地字体、长句适配、透明度及设置传播；明确排除鼠标输入专项 |
| 相关页面与状态 | 1440×950 和 1080×680 独立上下文受控截图已查看，主题、歌词预设、搜索、评论、队列及弹窗无横向溢出 |
| 公开国内更新原生探针 | 实际 `UpdateService` 选择 0.5.4 Gitee 清单，匿名完整下载 54,919,198 字节并通过大小和 SHA-256 校验，退出码 0；未触发 GitHub 回退 |

原生渲染检查使用 `YUYIN_QA_RENDER_ONLY=1` 运行本机 `.qa/ui-native/UiNative.csproj`，不是完整原生输入通过记录。本轮没有读取或修改真实用户 profile、Cookie、歌库、偏好或签名密钥。构建、测试与匿名发布下载证据保留在被忽略的 `.qa/` 与 `release/` 中，不随源码提交。

## 发布校验与边界

从这份干净源码构建的唯一最终 EXE 上传 GitHub 草稿后完整下载核对大小和 SHA-256，公开后另行匿名完整下载。初次大文件回读超时，随后分段续传完成校验，不替换已上传文件。Gitee 使用同一份字节，只有官方准备脚本完整匿名下载并回读 Release / 附件身份通过后才推进国内清单。具体发布身份和线上探针结果按 [发布记录](RELEASE.md) 记录。

两端公开 `stable.json` / `domestic.json` 均匿名回读，与已核对候选完全一致，且各 Release 只有一个最终安装附件。随后执行 `.tools/dotnet/dotnet.exe run --project tests/windows-host/Yuyin.HostTests.csproj -c Release -- --live-update-probe 0.5.4`，输出 `Public native Gitee probe passed`；探针使用自身随机临时缓存，没有启动应用、读取 profile / Cookie 或执行安装器。日志保留在 `.qa/publication/054-native-domestic.log`。

PC 完整原生鼠标输入专项仍有测试环境指针干扰，未将拖动、锁定、工具栏隐藏及全部控件命中记为本轮通过；网页截图和 13 项渲染检查不能替代。未完成真实 Bilibili 账号、网络评论写入、长时间音源播放、跨机器升级、缺少 WebView2 的首次联网安装或已安装客户端的完整更新安装流程。本轮受控安装检查不证明这些用户流程均已通过。Android 使用独立版本和 [独立验证记录](https://github.com/panda472328/yuyin-music-mobile/blob/main/docs/QA-0.1.5.md)。
