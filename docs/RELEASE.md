# 发布与文件管理

PC 与 Android 使用独立仓库、版本、依赖和构建产物。PC 源码位于本仓库；Android 源码位于 [yuyin-music-mobile](https://github.com/panda472328/yuyin-music-mobile)。不要把其中一个工程嵌套进另一个仓库。

## PC 0.4.9

公开发布页：[pc-v0.4.9](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.9)。

| 内容 | 文件 |
| --- | --- |
| Windows x64 安装包 | `Yuyin-0.4.9-Setup.exe` |
| Windows x64 便携版 | `Yuyin-0.4.9-Windows.exe` |
| 单个文件的校验值 | 与 EXE 同名的 `.sha256` |
| 全部附件校验值 | `SHA256SUMS.txt` |
| 来源与附件清单 | `release-manifest.json` |
| 项目及第三方完整许可文本 | `Yuyin-PC-0.4.9-Licenses.zip` |

本机公开附件整理到 `release/published/pc-v0.4.9/`，仅该版本的安装包、许可和校验文件放在一起；`release/` 中原产物保留原路径。所有二进制、依赖、缓存和 `.qa/` 均排除在源码提交之外。GitHub 根据发布标签提供源码 ZIP / TAR，包含 MIT、样式标准与开发说明。

本次采用已验证的 0.4.9 安装包及便携包，实际构建源码为 `01b76bff9ee7e1f8b7d06459de6e6f4cbf71ffea`。安装器的完整生命周期与正式包验证见 [QA.md](QA.md)；两个安装资产没有因许可证整理而重新构建。公开标签对应本轮增加许可证、文档及包元数据后的源码，manifest 分别记录 `binaryBuildCommit` 与 `releaseSourceCommit`。功能代码和应用版本保持 0.4.9。

## 后续发布

1. 在 PC 仓库检查工作目录、现有 diff 和版本；在 `package.json` 与锁文件同步递增版本并更新 CHANGELOG。
2. 完成与改动有关的检查。代码改动执行 `npm run typecheck`、`npm test`、`npm run build`；样式按 [STYLE-GUIDE.md](STYLE-GUIDE.md) 验证，纯文档改动核对事实与链接。
3. 从干净提交构建安装器和便携包，保留必要的第三方声明；在隔离数据目录验收对应包，核对实际版本和来源。
4. 将该版本公开附件复制到独立版本目录，生成 SHA-256、manifest 和完整许可证 ZIP，不移动日常用户的快捷方式或运行路径。
5. 给发布源码建立 `pc-v<版本>` 标签。先准备草稿 Release，上传并核对所有附件，再发布；已公开标签和附件保留用于追溯。

校验文件只用于核对下载内容；当前 PC EXE 尚未做 Windows 代码签名。签名、登录 Cookie 和用户音乐库不进 Git，也不作为 Release 附件。
