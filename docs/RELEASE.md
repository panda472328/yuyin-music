# 发布与文件管理

PC 与 Android 使用独立仓库、版本、依赖和构建产物。PC 源码位于本仓库；Android 源码位于 [yuyin-music-mobile](https://github.com/panda472328/yuyin-music-mobile)。不要把其中一个工程嵌套进另一个仓库。

## PC 0.4.9

公开发布页：[pc-v0.4.9](https://github.com/panda472328/yuyin-music/releases/tag/pc-v0.4.9)。

| 内容 | 文件 |
| --- | --- |
| Windows x64 安装包 | `Yuyin-0.4.9-Setup.exe` |

每个平台的发布页仅保留一个最终安装文件。PC 使用安装版 EXE；校验值、文件大小和源码来源写在发布说明中，完整许可通过 [第三方声明](../THIRD_PARTY_NOTICES.md) 查阅，不再作为下载页的独立附件。GitHub 自动生成的 Source code ZIP / TAR 是源码入口。

本机公开产物整理在 `release/published/pc-v0.4.9/`；原安装包、便携包、校验和构建记录保留在本机供追溯。二进制、依赖、缓存和 `.qa/` 不提交到源码仓库；第三方许可属于需要保留的文档。

本次采用已验证的 0.4.9 安装包，实际构建源码为 `01b76bff9ee7e1f8b7d06459de6e6f4cbf71ffea`，文件大小为 113,801,921 字节，SHA-256 为 `d2531d5f8ab088a09898a98dd55db30767d5e9e54e772b1f6fefee7997e34a11`。安装器的完整生命周期与正式包验证见 [QA.md](QA.md)。公开标签 `pc-v0.4.9` 指向开源整理提交 `54c188e671e44d8e73c75ebc0f5e6b028ee14b60`，后续发布页精简文档在 main 更新，不移动标签。功能代码和安装包保持 0.4.9。

## 后续发布

1. 在 PC 仓库检查工作目录、现有 diff 和版本；在 `package.json` 与锁文件同步递增版本并更新 CHANGELOG。
2. 完成与改动有关的检查。代码改动执行 `npm run typecheck`、`npm test`、`npm run build`；样式按 [STYLE-GUIDE.md](STYLE-GUIDE.md) 验证，纯文档改动核对事实与链接。
3. 从干净提交构建最终安装器，保留必要的第三方声明；在隔离数据目录验收对应包，核对实际版本和来源。便携版可在本机按需构建。
4. 将该版本安装包复制到独立版本目录，生成本机校验与来源记录；在发布说明写明 SHA-256、字节数、实际构建提交和源码标签，链接仓库中的完整许可文本。
5. 给发布源码建立 `pc-v<版本>` 标签。先准备草稿 Release，只上传一个最终安装版 EXE，核对文件与说明后发布。已公开标签和本机来源记录保留用于追溯；需要精简附件时保持原安装文件及版本不变。

SHA-256 只用于核对下载内容；当前 PC EXE 尚未做 Windows 代码签名。签名、登录 Cookie 和用户音乐库不进 Git，也不作为 Release 附件。
