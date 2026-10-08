# 余音 PC 样式标准

本标准帮助维护者与 agent 快速定位、修改和验证外观。基线是 PC 0.4.10 的米白／鼠尾草绿视觉；Android 0.1.1 采用相同品牌，但位于独立仓库。下文区分现有实现与新增主题时需要补齐的工作，不假定已存在运行时主题切换。

## 1. 修改入口与范围

| 要改什么 | 组件／逻辑入口 | 样式／配置入口 |
| --- | --- | --- |
| 整体配色 | `src/main.tsx` | `src/theme.css` → `src/styles.css` |
| 侧栏、品牌、搜索、页面、播放器、队列、歌单弹窗 | `src/App.tsx` | `src/styles.css` |
| 登录页与账号菜单 | `src/BilibiliAccount.tsx` | `src/styles.css` 的 `login-*`、`account-*` |
| 软件更新、登录页检查入口与新版本提示 | `src/Updates.tsx`，`src/App.tsx` 的顶层 provider | `src/styles.css` 的 `update-*`、`.login-update`；发布流程见 `docs/UPDATES.md` |
| Bilibili 收藏夹导入 | `src/BilibiliFavoritesDialog.tsx` | `src/styles.css` 的 `bilibili-*`、`.modal` |
| 主歌词页面 | `src/LyricsView.tsx` | `src/lyrics.css`，组件直接导入 |
| 主窗的桌面歌词设置 | `src/DesktopLyricsSettings.tsx` | `src/styles.css` 的 `desktop-lyrics-*` 设置类 |
| 独立桌面歌词 | `src/DesktopLyrics.tsx`、`src/desktop-lyrics-main.tsx` | **仅** `src/desktop-lyrics.css` |
| 桌面歌词可选字体／颜色和默认值 | 两个设置界面共用 | `electron/desktop-lyrics-types.ts` |
| 主窗口尺寸、系统标题栏 | `electron/main.ts` | `BrowserWindow` 参数与窗口状态恢复 |
| 桌面歌词原生窗口与指针检测 | `electron/desktop-lyrics.ts` | 固定尺寸、透明、置顶与工作区定位 |
| 桌面歌词设置校验／保存 | `electron/desktop-settings-store.ts` | 允许字段、枚举、范围与有效备份 |

主 renderer 导入 `styles.css`，其首行导入 `theme.css`。桌面歌词有自己的 HTML、入口、CSS 和 preload，不能给它导入主窗的全局 `body` 背景。`src/ui-settings.ts` 目前保存静音前音量及睡眠定时，**不是**通用主题设置文件。

先用 `rg` 查类名，再查看文件末尾和媒体查询。`styles.css` 后段存在字号、封面比例和 hero 尺寸的覆盖，例如导航最后为 14px、卡片封面最后为 `aspect-ratio: 1.35`。修改前段相同选择器可能不生效；编辑最终适用规则，避免在文件末尾反复追加同义覆盖。

## 2. 视觉颜色与 token

现有主界面基础变量位于 `src/theme.css`：

| 变量 | 默认值 | 含义／使用 |
| --- | --- | --- |
| `--canvas` | `#f7f8f3` | 页面底色，偏米白 |
| `--sidebar` | `#f1f4ec` | 侧栏的浅鼠尾草底色 |
| `--ink` | `#4d5a43` | 正文基础颜色 |
| `--green` | `#4c663a` | 品牌、主按钮、重点与焦点 |
| `--line` | `#e6eadf` | 结构分隔线 |
| `--surface` | `#fffefa` | 更新提示卡片表面 |
| `--text-muted` | `#788174` | 更新说明、版本检查补充文字 |
| `--warning-text` | `#8b715b` | 更新失败与校验失败文字 |

其他表面和状态色目前直接写在相应 CSS 中，修改整套主题时必须一起审查，不能只换五个变量就宣称全覆盖：

| 视觉角色 | 当前参考值／选择器 |
| --- | --- |
| 浅卡片／菜单表面 | `#fffefa`：`.login-card`、`.account-menu`、`.button-secondary` |
| 主窗选中导航 | `#e4edde`：`.nav-item.selected` |
| 普通悬停 | `#eaf0e5`、`#eaf0e6`：导航／图标按钮 |
| 重点文字／当前歌词 | `#486535`：`.lyric-line.is-current` |
| 次要文字 | 如 `#788174`（导航）、`#a2ae94`（未激活歌词）；按页面角色审查 |
| 危险动作 | `#ad6556`：`.button-danger` |
| 温和错误／警告 | `#f5eee7`、`#8b715b`：`.error-state` |
| 主窗底部半透明表面 | `#fcfdf9f5`：`.player-bar` |

新增公共颜色使用语义名，如 `--surface`、`--text-muted`、`--accent-hover`、`--danger`，并在这里登记默认值与消费者。不要用 `--color1` 或把同一用途的新十六进制值散落在多个组件。替换现有硬编码时逐项确认角色，装饰渐变／唱片纹理可保留组件内定义。

独立桌面歌词通过 `DesktopLyrics.tsx` 内联设置 `--lyrics-font`、`--lyrics-color`、`--lyrics-opacity`，CSS 消费这些值。默认月白 `#ffffff`，薄荷 `#b9f2d0`，暖金 `#ffe39c`。深色工具栏与文字描边服务于桌面可读性，不随主窗米白底色一起替换。透明度只作用于歌词副本与曲名，工具栏仍需可见和可点。

## 3. 字体、图标与尺寸

主窗字体栈是 `'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif`，基础 14px。优先用系统字体和 `lucide-react` 图标；图标跟随 `currentColor`，保持 `aria-label` 与可见状态一致。

| 内容 | 当前桌面参考尺寸 |
| --- | --- |
| 品牌「余音」 | 25px，登录标题栏为 22px |
| 侧栏导航 | 最终覆盖为 14px；歌单标题 13px／补充 11px |
| 搜索框 | 最终覆盖为 12px |
| 歌曲标题 | 表格 13px；次要字段 11px |
| 通用按钮／设置标题 | 最终覆盖为 12px |
| 歌词行 | 21px，≤1200px 时 19px；当前行 700 字重 |
| 桌面歌词当前句 | 用户选 24–56px，默认 36px；长句由 `useFittedText` 自动缩小 |
| 桌面歌词下一句 | 依当前字号计算，14–24px |

现有间距多为 4／8／12／16px 附近，主要圆角 7–12px，主卡片 17–19px。延续当前节奏，新组件避免任意增加不同圆角和字重。字体扩大时同步检查行高、网格最小宽度、长标题省略和最小窗口，而不是只改 `font-size`。

正文和图标应可辨认，新增主题特别检查浅底／深底文字、禁用态、选中态和焦点。不要因全局 `outline: none` 删除现有 `:focus-visible` 轮廓；hover 不得成为唯一可访问操作。

## 4. 组件与状态选择器

| 区域 | 主要选择器 | 必须保留的状态／行为 |
| --- | --- | --- |
| 应用骨架 | `.app-shell`、`.sidebar`、`.main-shell`、`.main-content` | 单独内容滚动、侧栏可滚动、底部播放器留白 |
| 品牌与导航 | `.brand`、`.brand-icon`、`.nav-item`、`.sidebar-playlist` | `.selected`、hover、数量、省略长歌单名 |
| 顶栏 | `.topbar`、`.search-box`、`.topbar-right` | 输入焦点、快捷键、窗口拖动与控件命中 |
| 账号 | `.account-menu-anchor`、`.account-trigger`、`.account-avatar`、`.account-menu-position` | `.expanded`、头像失败降级、hover／键盘菜单 |
| 登录 | `.login-shell`、`.login-titlebar`、`.login-layout`、`.login-card`、`.login-actions` | 验证中、未登录、过期、网络错误、重试与关闭 |
| 首页 | `.hero`、`.hero-content`、`.hero-art`、`.record`、`.song-cards`、`.playlist-cards` | 唱片与封面不覆盖按钮，卡片收藏与播放 |
| 通用按钮 | `.icon-button`、`.button-primary`、`.button-secondary`、`.button-danger` | `.active`、disabled、hover、focus-visible |
| 歌曲列表 | `.song-table-header`、`.song-row`、`.song-identity`、`.song-actions` | `.current`、hover、长标题、省略、点击／双击播放 |
| 歌曲操作菜单 | `.song-menu-anchor`、`.dropdown-menu` | 右侧定位、危险动作、内容滚动时不被误挡 |
| 收藏／历史／歌单 | `.collection-header`、`.collection-art`、`.collection-toolbar` | 不同封面色、长标题、空状态 |
| 播放器 | `.player-bar`、`.now-playing`、`.playback-center`、`.main-play`、`.timeline`、`.player-tools` | playing／paused／loading／error，拖进度和音量 |
| 队列 | `.queue-panel`、`.queue-list`、`.queue-song`、`.queue-empty` | `.current`、删除／清空、独立滚动 |
| 设置 | `.settings-panel`、`.setting-row`、`.switch` | `.on`、`aria-checked`、保存错误、忙时禁用 |
| 软件更新 | `.update-settings`、`.update-setting-row`、`.update-actions`、`.update-banner`、`.login-update` | checking／available／downloading／downloaded／installing／error，进度、重试、稍后更新；便携版引导下载安装版 |
| 弹窗 | `.modal-backdrop`、`.modal`、`.bilibili-modal` | 焦点管理、Escape、表单、长收藏夹列表滚动 |
| 提示 | `.toast`、`.playback-error`、`.error-state`、`.empty-state`、`.loading-state` | 错误不被静默隐藏，按钮可执行下一步 |
| 主歌词 | `.lyrics-page`、`.lyrics-layout`、`.lyrics-scroll`、`.lyric-line`、`.lyrics-reading-footer` | `.is-bilibili`、`.is-current`、`.is-calibrating`、来源／偏移／刷新 |
| 桌面歌词 | `.desktop-lyrics`、`.desktop-lyrics-toolbar`、`.desktop-lyrics-copy`、`.desktop-lyrics-caption` | `.toolbar-visible`／`.toolbar-hidden`、`.is-locked`、`.has-error`、`.is-placeholder` |

主歌词的 `[data-active="true"]` 用于居中滚动，`aria-current` 表示当前句。Bilibili 来源的 `.lyric-line` 禁用颜色过渡，滚动为即时 `auto`；LRCLIB 保留平滑滚动。不要为了动画重新引入字幕延迟。校准中暂停自动跟随；普通点句跳转、校准点句只调整偏移，样式改动不得更改这一语义。

## 5. 布局与窗口约束

主窗口默认 **1440×950**，最小 **1080×680**，参数在 `electron/main.ts`。已有窗口状态恢复带 DPI 尺寸校正，不用 CSS 改动替换它。

- `.app-shell` 左栏默认 222px，右侧 `minmax(0, 1fr)`；≤1200px 左栏 195px。主内容 padding 默认左右 45px，≤1200px 为 30px。
- 底部播放器固定 98px，应用壳 `padding-bottom: 98px`、队列 `bottom: 98px` 与提示位置必须联动，避免内容被挡。
- 顶栏 91px，右上 Windows 原生标题栏 overlay 高 34px；不要把交互按钮布置到系统最小化／关闭按钮的命中区域。
- 歌曲表头与行共享列定义，新增或隐藏列必须同时调整；保留 `min-width: 0`、`min-height: 0` 与正确滚动容器。
- 歌词页默认 285px 歌曲卡＋可伸缩歌词列，间隔 60px；≤1200px 改为 235px＋28px。低于 780px 的高度有额外紧凑规则，校准状态有单独可用高度。
- 主 CSS 有 ≤900px 的网页预览规则，但 PC 原生最小宽 1080px；不要用这些规则假定实现了手机版。≥1600px 有大屏装饰调整。

层级参考：歌曲菜单 15、队列 18、播放器 20、播放错误 22、账号锚点 45、弹窗 50、toast 100；独立歌词工具栏 10／状态提示 2。新增浮层选择符合遮挡关系的层级，不使用任意巨大 `z-index`。transform／opacity／filter 可产生新 stacking context，调整后实测菜单遮挡。

更新提示层级为 30，主界面右下固定在播放器上方，底部 114px；登录界面移至左下，避开右侧登录按钮。最大高度限制并允许内部滚动；≤780px 高度时登录卡减少留白，保留全部控件。歌单或收藏夹弹窗打开时隐藏更新提示，避免新增按钮进入弹窗的键盘焦点循环。提示不抢焦点；“稍后更新”仅隐藏本轮提示，下载完成的新状态仍可再次提醒。登录页与设置页都提供检查入口，更新不依赖 Bilibili 账号。更新提示及全部后代为 `no-drag`，不要给全局桌面歌词 renderer 导入这些样式。版本文案由 `package.json`／原生状态读取，不写固定版本号。

外观改动保留“发现新版→用户选择下载→校验通过→用户选择退出并安装”的状态和动作顺序。自动检查不得下载或安装，安装失败和网络错误必须可见且可重试；状态只来自受限更新 IPC，不在 renderer 接受任意下载 URL、路径或脚本。

桌面歌词原生尺寸固定 **900×200**，透明、无边框、置顶、不显示任务栏；控制器将其保持在显示器工作区内。CSS 上方预留工具栏，`.has-error` 增加留白，当前句与下一句完整显示。改变原生尺寸需同步 `electron/desktop-lyrics.ts`、`electron/desktop-settings-store.ts` 中旧位置读入尺寸、长句自适应和屏幕边界验收，不能只改 CSS。

## 6. 原生拖动、锁定和工具栏

Electron 拖动区域不是普通 DOM 拖拽。主窗 `.brand`、`.topbar`、`.login-titlebar` 设置 `-webkit-app-region: drag`；交互后代必须 `no-drag`。账号锚点及**全部后代**明确 `no-drag`，避免 SVG 路径点击变成拖窗。新增 select、range、链接、图标或按钮到拖动区时，对控件及后代设置 `no-drag`。

桌面歌词的歌词、标题、空白和工具栏左侧 `.desktop-lyrics-handle` 可拖动；工具栏与全部后代默认 `no-drag`，仅手柄重新启用 `drag`。`.is-locked` 覆盖整个窗口及手柄为 `no-drag !important`。锁定禁止移动，同时保留字体、透明度、解锁、关闭等控件操作。

工具栏可见性由 `DesktopLyrics.tsx` 的定时器与 preload `onPointerPresence` 共同控制，原生控制器检测窗口内指针，处理透明拖动区可能不派发 DOM 事件的情况。当前逻辑是指针在窗口内保持可见、离开后约 2200ms 隐藏；初次／焦点操作会显示。不要仅删除 CSS opacity、仅用 hover、给窗口开启整体鼠标穿透，或改成固定显示。

`.toolbar-hidden` 同时禁用 visibility 和 pointer-events，`.toolbar-visible` 恢复命中；错误提示 `pointer-events: none`，不能遮住设置栏。任何相关调整都要用真实 Electron 窗口检查指针进入、下拉菜单操作、离开隐藏、再次进入、锁定解锁与拖动。静态截图只能证明外观。

## 7. 常见修改方法

### 修改现有颜色、间距或主窗字体

1. 根据组件表定位最终选择器；共享基础配色修改 `theme.css`，组件局部状态修改所属 CSS。
2. 先复用 token；新建语义 token 时同步消费者及本表。主窗字体改 `styles.css` 的 `body`，保持系统字体 fallback。
3. 检查相邻状态与媒体查询，保存 aria、disabled 和焦点行为；不触碰播放器或存储来实现视觉效果。
4. 构建并在隔离实例查看受影响页面及长内容，记录截图和验证范围。

### 新增主窗主题

当前仅一个静态主题，暂无通用主题枚举／切换器。若任务只要求整体换色，直接改现有 token 与组件色。若明确要用户切换主题，按以下路径实现：

1. 在 `theme.css` 保留默认 `:root`，新增明确的 `[data-theme="主题ID"]` 变量集合，例如：

   ```css
   :root[data-theme="forest"] {
     --canvas: #f2f5ed;
     --sidebar: #e8eee0;
     --ink: #384a31;
     --green: #355c2c;
     --line: #d8e2cf;
   }
   ```

2. 为所有表面、次要文字、悬停、错误及歌词状态提取对应语义变量，分别修改 `styles.css`、`lyrics.css`；上述示例只说明选择器约定，不能独自实现完整主题。
3. 在主 renderer 根元素设置 `document.documentElement.dataset.theme`。新增保存字段需明确默认值、允许主题 ID、旧数据兼容，并沿用 `local-preferences.ts`／`ui-settings.ts` 与 `electron/preferences-store.ts` 的校验保存链路；不要创建另一套随安装目录变化的存储或接受任意 CSS 文本。
4. 主窗口 `backgroundColor` 和 `titleBarOverlay` 当前是原生固定色，需要运行时同步时实现主进程校验后的受限更新；不要关闭隔离或给前台暴露任意原生 API。
5. 独立桌面歌词保持透明，决定是否仅更新工具栏，不套用主窗 body。主窗主题切换不改变音源、队列、歌词来源或时间校准。
6. 每个主题的状态与两种窗口尺寸均验收；新增持久化／IPC 需要相应业务回归。

### 新增桌面歌词字体或颜色

1. 在 `electron/desktop-lyrics-types.ts` 扩展 `DesktopLyricsSettings` 对应枚举，并向 `DESKTOP_LYRICS_FONT_OPTIONS` 或 `DESKTOP_LYRICS_COLOR_OPTIONS` 加选项。字体写完整 fallback，使用稳定 ID；勿重命名既有 ID 或改变其含义。
2. 同步 `electron/desktop-settings-store.ts` 的允许值校验。主设置页与歌词工具栏从同一数组渲染，不在一个界面手工添加不同配置。
3. 保留默认值与旧保存记录兼容；新增选项不能使旧文件读取失败。扩展字号／透明度范围时同步校验、主设置控件、工具栏限制和布局检查。
4. `DesktopLyrics.tsx` 自动从选项取得 fontFamily／color，通过 CSS 变量渲染，并在字体加载和尺寸变化后重新 fit。不要用 `!important font-size` 绕过自适应，长中文／英文句仍需完整显示。
5. 检查两窗设置同步、保存后重启恢复、缺字体 fallback，以及浅／深桌面上的描边与阴影。引入可分发字体时放在项目资源中并记录许可；系统字体文件不提交。

## 8. PC 与 Android 的统一规则

共同品牌包括「余音 / YUYIN MUSIC」、米白／鼠尾草绿基色、唱片与封面元素、圆角卡片、按钮主次关系、歌词当前句的绿色高亮，以及加载／错误／空状态用语。平台布局各自适配：PC 是侧栏与固定播放器，手机是触屏与安全区布局，不能直接复制 PC 宽度或拖窗规则。

- PC 仓库 `yuyin-music` 与手机仓库 `yuyin-music-mobile` 分别保存源代码、Git 历史和版本；当前不存在共享 npm 样式包、自动同步或跨端主题设置同步。
- 手机相关入口是其 `src/theme.css`、`src/styles.css`、`src/App.tsx`，以手机仓库实际文件为准。先比对其 token／类名，再实现语义对应，不假定所有 CSS 选择器相同。
- 共用品牌修改先在本标准记录颜色／字体／图标语义，再分别修改两端。只授权改 PC 时，提交说明需列出手机版是否需同步，不自行覆盖另一个仓库。
- 每端单独验证、提交、升级版本和发布；PC 标签 `pc-vX.Y.Z`，手机公开发布标签 `android-vX.Y.Z`，保留早期 `mobile-v` 历史。PC 的桌面歌词与窗口拖拽规则不适用于 Android。

## 9. 最小验证与交付

纯样式修改至少：

```sh
npm run typecheck
npm run build
```

涉及状态、存储、IPC、校准或播放行为再运行 `npm test`，补充对应回归。无需为可逆间距／颜色编写只复刻 CSS 值的测试。

按 [CONTRIBUTING.md](../CONTRIBUTING.md) 使用新建绝对路径的 `--user-data-dir`，不要在真实账号和存储上验收。用虚构歌曲、受控歌词／搜索响应；加载真实 Bilibili 内容的验证需独立说明范围。

| 检查 | 最小覆盖 |
| --- | --- |
| 主窗口 | 1440×950 与 1080×680；需要时 Windows 125% DPI |
| 页面 | 修改区域及相关登录、搜索、歌单、设置、歌词／队列／弹窗 |
| 状态 | normal、hover、focus-visible、selected/current、disabled、loading、empty、error |
| 长内容 | 长中文／英文标题、长歌单、长歌词、封面加载失败 |
| 交互 | 键盘搜索／Escape、Tab 焦点、表单、range 拖动、账号菜单 |
| 桌面歌词 | 4 字体×3 颜色的相关样本，24／56px、30%／100% 透明度、浅／深背景、长句 fit |
| 原生命中 | 工具栏可见／隐藏／再次进入、控件不拖动、手柄可拖动、锁定、工作区边界 |
| 保存 | 新增设置的双窗同步、正常退出后重启保留、旧配置兼容 |

提交说明写清改动文件、视觉效果、实际执行的验证与限制。记录浏览器预览、真实 Electron 受控响应、真实网络播放、原生输入这几类不同证据，不能把其中一种写成另一种已经通过。截图与日志不得包含个人昵称、头像、cookies、真实音乐库或签名信息。构建包及 `.qa/` 不提交源码；发布产物按版本进入 GitHub Release。
