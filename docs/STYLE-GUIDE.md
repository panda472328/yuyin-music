# openmusic PC 样式标准

本标准帮助维护者与 agent 快速定位、修改和验证外观。基线是 PC 0.5.0 的米白／鼠尾草绿视觉，当前 PC 展示品牌改为小写 `openmusic`；Android 位于独立仓库，本次未修改其品牌。下文区分现有实现与新增主题时需要补齐的工作，不假定已存在运行时主题切换。

展示改名覆盖主界面、登录页、窗口标题、账号页面授权说明、导出对话框、安装向导与快捷方式名称。兼容技术标识不随之替换：宿主命名空间／程序集、`YUYIN_*` 环境变量、`%LOCALAPPDATA%/YuyinMusic`、本地存储键、安装／卸载登记、更新文件名及既有 GitHub／Android 仓库地址保留原值。已发布安装包、标签、版本号、校验值与历史验收记录保留原名；不能把展示改名写成数据迁移或已发布新版本。改名后的安装器管理新的 openmusic 快捷方式，升级时不自动删除旧「余音」快捷方式，以免影响独立安装的旧 Electron 版；旧快捷方式可能需要用户确认后手动清理。

## 1. 修改入口与范围

| 要改什么 | 组件／逻辑入口 | 样式／配置入口 |
| --- | --- | --- |
| 整体配色 | `src/main.tsx` | `src/theme.css` → `src/styles.css` |
| 侧栏、品牌、搜索、页面、播放器、队列、歌单弹窗 | `src/App.tsx`、`src/SearchBox.tsx` | `src/styles.css` |
| 登录页与账号菜单 | `src/BilibiliAccount.tsx` | `src/styles.css` 的 `login-*`、`account-*` |
| 软件更新、登录页检查入口与新版本提示 | `src/Updates.tsx`，`src/App.tsx` 的顶层 provider | `src/styles.css` 的 `update-*`、`.login-update`；发布流程见 `docs/UPDATES.md` |
| Bilibili 收藏夹导入 | `src/BilibiliFavoritesDialog.tsx` | `src/styles.css` 的 `bilibili-*`、`.modal` |
| 当前视频评论、点赞与回复 | `src/CommentsView.tsx`、`src/useComments.ts`、`src/comments-controller.ts` | `src/comments.css`，组件直接导入；原生接口在 `windows-host/BilibiliComments.cs` |
| 当前视频 MV 与后台源窗口 | `src/App.tsx` 的侧栏 MV／底栏评论；`src/api.ts`、`src/webview2-bridge.ts` | 沿用 `.nav-item`／`.icon-button`；宿主在 `windows-host/PlayerHost.cs`，网页全屏脚本在 `windows-host/BilibiliMV.cs` |
| 主歌词页面 | `src/LyricsView.tsx` | `src/lyrics.css`，组件直接导入 |
| 主窗的桌面歌词设置 | `src/DesktopLyricsSettings.tsx` | `src/styles.css` 的 `desktop-lyrics-*` 设置类 |
| 独立桌面歌词 | `src/DesktopLyrics.tsx`、`src/desktop-lyrics-main.tsx` | **仅** `src/desktop-lyrics.css` |
| 桌面歌词可选字体／颜色和默认值 | 两个设置界面共用 | `electron/desktop-lyrics-types.ts`（共享类型） |
| 主窗口尺寸、系统标题栏 | `windows-host/MainWindow.xaml`、`windows-host/MainWindow.xaml.cs` | WPF 窗口参数与窗口状态恢复 |
| 桌面歌词原生窗口与指针检测 | `windows-host/DesktopLyricsHost.cs` | 固定尺寸、透明、置顶与工作区定位 |
| 桌面歌词设置校验／保存 | `windows-host/DesktopSettingsStore.cs` | 允许字段、枚举、范围与有效备份 |

主 renderer 导入 `styles.css`，其首行导入 `theme.css`。桌面歌词有自己的 HTML、入口、CSS 和受限 WebView2 bridge，不能给它导入主窗的全局 `body` 背景。`src/ui-settings.ts` 目前保存静音前音量及睡眠定时，**不是**通用主题设置文件。

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
| 品牌 `openmusic` | `.brand-name` 为 20px／字间距 0.3px，登录标题栏 22px；`.brand-subtitle` 为 8px／字间距 1px |
| 侧栏导航 | 最终覆盖为 14px；歌单标题 13px／补充 11px |
| 搜索框 | 最终覆盖为 12px |
| 歌曲标题 | 表格 13px；次要字段 11px |
| 通用按钮／设置标题 | 最终覆盖为 12px |
| 歌词行 | 21px，≤1200px 时 19px；当前行 700 字重 |
| 桌面歌词当前句 | 用户选 24–56px，默认 36px；长句由 `useFittedText` 自动缩小 |
| 桌面歌词下一句 | 依当前字号计算，14–24px |

现有间距多为 4／8／12／16px 附近，主要圆角 7–12px，主卡片 17–19px。延续当前节奏，新组件避免任意增加不同圆角和字重。字体扩大时同步检查行高、网格最小宽度、长标题省略和最小窗口，而不是只改 `font-size`。

`openmusic` 比原来的两个中文字宽。品牌字标需完整显示、保持小写，不使用中文标题的 4px 字间距，不靠裁切或省略号掩盖溢出。主侧栏在 222px 与紧凑 195px 两种宽度下都要保留图标大小、字标与间距；`.brand` 水平外边距为 8px，`.brand-icon` 为 `flex-shrink: 0`。优先调整品牌自身字号、字间距和外边距，不扩大侧栏挤压搜索与主内容。主窗与登录页均使用 `.brand-name`／`.brand-subtitle`，登录标题栏共用品牌语义并单独确认宽度，仍保留 `.brand` 的 `drag` 和关闭按钮的 `no-drag`。字标旁的英文补充不能继续使用旧品牌 `YUYIN MUSIC`；文案与选择器变更需两处同步。独立桌面歌词同步修改窗口标题、工具栏、空闲占位、曲名提示及 aria 文案中的品牌，保留独立 CSS，不套用主品牌布局。

正文和图标应可辨认，新增主题特别检查浅底／深底文字、禁用态、选中态和焦点。不要因全局 `outline: none` 删除现有 `:focus-visible` 轮廓；hover 不得成为唯一可访问操作。

## 4. 组件与状态选择器

| 区域 | 主要选择器 | 必须保留的状态／行为 |
| --- | --- | --- |
| 应用骨架 | `.app-shell`、`.sidebar`、`.main-shell`、`.main-content` | 单独内容滚动、侧栏可滚动、底部播放器留白 |
| 品牌与导航 | `.brand`、`.brand-icon`、`.brand-name`、`.brand-subtitle`、`.nav-item`、`.sidebar-playlist` | 完整小写字标、图标不收缩、`.selected`、hover、数量、省略长歌单名 |
| 顶栏 | `.topbar`、`.search-box`、`.search-mode`、`.topbar-right` | 输入焦点、快捷键、模式按钮的 `aria-pressed`、窗口拖动与控件命中 |
| 歌名联想 | `src/SearchBox.tsx`；`.search-suggestions`、`.search-suggestions-list`、`.search-suggestions-status` | combobox／listbox、选中候选、最多 10 条／250ms、IME、慢请求拒绝、联想失败仍可搜索、选联想不自动播放 |
| 账号 | `.account-menu-anchor`、`.account-trigger`、`.account-avatar`、`.account-menu-position` | `.expanded`、头像失败降级、hover／键盘菜单、从头像移入菜单的关闭缓冲 |
| 登录 | `.login-shell`、`.login-titlebar`、`.login-layout`、`.login-card`、`.login-actions`、`.login-guest`、`.guest-login` | 验证中、未登录、游客、过期、网络错误、重试与关闭 |
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
| 评论区 | `.comments-page`、`.comments-video`、`.comments-sort`、`.comment-composer`、`.comment-item`、`.comment-thread` | 热门／最新、游客／验证中、loading／empty／closed／error、点赞忙、发送／审核／结果未确认 |
| 桌面歌词 | `.desktop-lyrics`、`.desktop-lyrics-toolbar`、`.desktop-lyrics-copy`、`.desktop-lyrics-caption` | `.toolbar-visible`／`.toolbar-hidden`、`.is-locked`、`.has-error`、`.is-placeholder` |

主歌词的 `[data-active="true"]` 用于居中滚动，`aria-current` 表示当前句。Bilibili 来源的 `.lyric-line` 禁用颜色过渡，滚动为即时 `auto`；LRCLIB 保留平滑滚动。不要为了动画重新引入字幕延迟。校准中暂停自动跟随；普通点句跳转、校准点句只调整偏移，样式改动不得更改这一语义。

PC 0.5.0 包含游客与搜索模式流程。登录页“暂不登录，先听歌”在检查账号期间也可使用；游客右上角 `.guest-login` 显示登录入口，真实登录后才显示 `.account-trigger` 与头像菜单。游客与真实账号切换复用主界面，不清空搜索或本地音乐库；账号收藏夹仍需真实登录。

评论页入口为右下播放器工具栏的气泡按钮（`aria-label="显示评论"`），占用原源视频入口的位置，保留 `.active` 与 `aria-pressed`，点击进入评论并关闭队列，重复点击不重建评论页或清除草稿。始终对应 `PlaybackStatus.song.bvid`，切歌或账号会话变化清除旧列表、回复目标和草稿，旧请求不能更新新上下文。普通账号轮询不清除草稿。热门／最新按钮保留 `aria-pressed`，点赞保留 `aria-pressed` 与作者标签，楼中楼开关保留 `aria-expanded`／`aria-controls`；评论正文按纯文本换行显示，不渲染来源 HTML。输入框使用关联 label、长度提示与可见焦点。页面使用现有 `--canvas`、`--surface`、`--sidebar`、`--ink`、`--green`、`--line`、`--text-muted`、`--warning-text`，不新增全局配色。

侧栏原评论位置改为“Bilibili · MV”。它是打开当前视频的动作，不是主页面导航，不清除当前评论草稿或重建评论页；沿用 `.nav-item`、`Video` 图标及 `no-drag`，无歌曲／加载／打开中禁用，打开中显示 spinner 与 `aria-busy`。`openMV()` 经受限 `music.mv` IPC 复用后台的同一个 WebView2 和视频，进入源站网页全屏；不可通过重新导航、重新播放或 seek 实现，也不能把 MV 点击当作播放器时间轴接管。评论页和播放错误中的“打开源视频”保留普通源网页，用于核对评论或完成验证，与 MV 入口分开。

MV 使用可关闭的独立来源窗口，网页全屏铺满窗口内容，不强制系统独占全屏。Esc、关闭或最小化将同一源窗口返回屏外继续播放；网页全屏控件缺失／验证／未加载时保留普通来源窗口并提示。窗口命中和 Esc 必须在 WebView2 网页实际获得焦点后验收，不能以 React 预览或直接调用窗口处理函数代替。

评论页及全部后代明确 `no-drag`，在 `.main-content` 内滚动，不新增覆盖播放器的浮层。评论、回复和点赞仅由明确点击提交至 Bilibili；游客只读，账号验证、列表读取或提交中禁用冲突动作。发送失败保留草稿，未知发送结果提示先核对源视频；不能用自动重试或乐观成功提示掩盖写入结果。CSRF 与 cookies 留在原生宿主，renderer 只传目标视频、评论字符串 ID、正文和预期账号 MID。外观修改不能改变这些约束或播放快捷键对 textarea 的保护。

搜索框内 `.search-mode` 使用两个原生按钮组成 `role="group"`，以 `aria-pressed` 表示选择，保留 Tab／Enter 和焦点样式。歌名模式默认开启，输入标签为“搜索歌名或歌手”；视频模式为“搜索 Bilibili 视频”。歌名模式允许部分歌名、歌名加歌手或版本词；视频模式直接使用官方视频排序。选择写入 `library.json` 的 `settings.searchMode`，旧库缺失或非法值使用 `song`。切换模式时保留输入框原文，重新搜索使用当前模式和原文，并用请求序号和当前模式拒绝旧模式的晚到响应。联想下拉保持 combobox／listbox、选中项与键盘语义，不能因为样式修改丢失 IME 保护或 `no-drag` 命中规则；联想、搜索和选联想都不自动播放。

歌名模式的输入联想和正式搜索独立执行。联想请求 `https://s.search.bilibili.com/main/suggest?term=...`，250ms 防抖，最多 10 条，支持键盘上下／Enter／Escape 和 IME；联想失败仍可直接搜索。沿官方页码召回并保留全部结果，每页及已加载合并结果按标题相关性稳定排序，完整等值、前缀、包含、分词关系优先，同分沿官方页／项顺序；只使用标题，不把 UP 主或简介当作歌手元数据。视频模式不重排。排序只覆盖已召回结果，不宣称全站最相关。规则在 `src/shared/search-mode.ts`，每页调用入口在 `src/api.ts`、`electron/bilibili.ts` 和 `windows-host/BilibiliService.cs`；已加载合并去重后的排序在 `src/App.tsx`，IPC 校验在 `windows-host/MainWindow.xaml.cs`。纯外观改动不得改变这些行为。

响应中的合法空数组显示无结果；缺失结果字段、非数组结构、异常状态码或验证页面必须保留错误／验证提示，不能当作正常空结果。联想错误不清空输入或禁用正式搜索。调整空状态、错误状态和联想下拉外观时保持这一区别。

公开设计参考为 [Spotify Search API](https://developer.spotify.com/documentation/web-api/reference/search) 的曲目／歌手字段查询和 [Apple Get Catalog Search Suggestions](https://developer.apple.com/documentation/applemusicapi/get-catalog-search-suggesions) 的输入建议。它们说明可公开使用的搜索方式，没有公开完整排名算法；openmusic 实际数据与联想来自 Bilibili，本地仅做上述标题相关性规则。

进度条展示 `windows-host/PlayerHost.cs` 发布的可信时间轴。新选曲和同曲重播从 0 开始；播放中无用户接管的异常前跳／回退恢复最近可信位置，纠正未完成时也保持该位置，不能在界面自行归零。暂停、缓冲和倍速参与进度判断，普通暂停不解除保护；应用手动跳转或源页可信 `pointerdown`／`keydown` 才接管时间轴。样式变更不得修改这一保护、快照顺序或歌词校准行为。

账号菜单的锚点和下拉层都必须保持 `no-drag`。指针从头像移到下拉层时使用约 700ms 的关闭缓冲；重新进入头像或菜单、菜单项获得焦点、点击、Escape 和外部点击都要正确取消或结束该计时器。不要通过永久显示菜单、扩大到遮挡标题栏的透明点击区或删除键盘关闭行为来规避间隙问题。

## 5. 布局与窗口约束

主窗口默认 **1440×950**，最小 **1080×680**，参数在 `windows-host/MainWindow.xaml`。已有窗口状态恢复带 DPI 尺寸校正，不用 CSS 改动替换它。

- `.app-shell` 左栏默认 222px，右侧 `minmax(0, 1fr)`；≤1200px 左栏 195px。主内容 padding 默认左右 45px，≤1200px 为 30px。
- 底部播放器固定 98px，应用壳 `padding-bottom: 98px`、队列 `bottom: 98px` 与提示位置必须联动，避免内容被挡。
- 顶栏 91px，右上 Windows 原生标题栏 overlay 高 34px；不要把交互按钮布置到系统最小化／关闭按钮的命中区域。
- 歌曲表头与行共享列定义，新增或隐藏列必须同时调整；保留 `min-width: 0`、`min-height: 0` 与正确滚动容器。
- 歌词页默认 285px 歌曲卡＋可伸缩歌词列，间隔 60px；≤1200px 改为 235px＋28px。低于 780px 的高度有额外紧凑规则，校准状态有单独可用高度。
- 主 CSS 有 ≤900px 的网页预览规则，但 PC 原生最小宽 1080px；不要用这些规则假定实现了手机版。≥1600px 有大屏装饰调整。

层级参考：歌曲菜单 15、队列 18、播放器 20、播放错误 22、账号锚点 45、弹窗 50、toast 100；独立歌词工具栏 10／状态提示 2。新增浮层选择符合遮挡关系的层级，不使用任意巨大 `z-index`。transform／opacity／filter 可产生新 stacking context，调整后实测菜单遮挡。

更新提示层级为 30，主界面右下固定在播放器上方，底部 114px；登录界面移至左下，避开右侧登录按钮。最大高度限制并允许内部滚动；≤780px 高度时登录卡减少留白，保留全部控件。歌单或收藏夹弹窗打开时隐藏更新提示，避免新增按钮进入弹窗的键盘焦点循环。提示不抢焦点；“稍后更新”仅隐藏本轮提示，下载完成的新状态仍可再次提醒。登录页与设置页都提供检查入口，更新不依赖 Bilibili 账号。更新提示及全部后代为 `no-drag`，不要给全局桌面歌词 renderer 导入这些样式。版本文案由 `package.json`／原生状态读取，不写固定版本号。

外观改动保留“发现新版→用户选择下载→校验通过→用户选择退出并安装”的状态和动作顺序。自动检查不得下载或安装，安装失败和网络错误必须可见且可重试；状态只来自受限更新 IPC，不在 renderer 接受任意下载 URL、路径或脚本。

桌面歌词原生尺寸固定 **900×200**，透明、无边框、置顶、不显示任务栏；控制器将其保持在显示器工作区内。CSS 上方预留工具栏，`.has-error` 增加留白，当前句与下一句完整显示。改变原生尺寸需同步 `windows-host/DesktopLyricsHost.cs`、`windows-host/DesktopSettingsStore.cs` 中旧位置读入尺寸、长句自适应和屏幕边界验收，不能只改 CSS。

## 6. 原生拖动、锁定和工具栏

0.5.0 主窗由 WPF 承载 WebView2。CSS 的 `-webkit-app-region` 仍是桥接命中语义：主窗 `.brand`、`.topbar`、`.login-titlebar` 设置 `-webkit-app-region: drag`，`windows-host/bridge.js` 把可信 pointerdown 转为白名单 `window.drag`，再由宿主调用 `DragMove()`。它不是 Electron 自带的原生拖动。交互后代必须 `no-drag`。搜索框、游客登录入口、账号锚点及**全部后代**明确 `no-drag`，避免 SVG 路径点击变成拖窗。新增 select、range、链接、图标或按钮到拖动区时，对控件及后代设置 `no-drag`。

桌面歌词的歌词、标题、空白和工具栏左侧 `.desktop-lyrics-handle` 可拖动；工具栏与全部后代默认 `no-drag`，仅手柄重新启用 `drag`。`.is-locked` 覆盖整个窗口及手柄为 `no-drag !important`。锁定禁止移动，同时保留字体、透明度、解锁、关闭等控件操作。

独立桌面歌词由 `DesktopLyrics.tsx` 的 ResizeObserver 报告 CSS 像素下的 viewport、工具栏、手柄矩形和可见性，`desktopLyricsAPI.setDragRegions()` 发送白名单 `desktopLyrics.window.dragRegions`。`windows-host/DesktopLyricsHost.cs` 校验矩形，并在 WPF `PreviewMouseLeftButtonDown` 中先排除锁定状态与可见工具栏控件，再对歌词、标题、空白或手柄调用 `DragMove()`；不能无条件拦截整个控件的点击。宿主每 100ms 发出指针存在状态，位置变化约 250ms 后原子保存，关闭时保存最终位置并解绑窗口／WebView2 事件。修改工具栏布局时必须重新同步矩形并做真实原生命中验收。

WebView2 的透明桌面歌词使用 `WebView2CompositionControl`，通过 WPF visual tree 绘制；主窗口和后台播放器继续使用普通 `WebView2`。控件依赖 Windows 10 1903 起的 Graphics Capture；产品与安装器的最低系统应为 1903，项目 Windows TFM 保留 WebView2 要求的 17763 SDK projection，并随发布输出 `Microsoft.Windows.SDK.NET.dll` 与 `WinRT.Runtime.dll`。不要将透明窗口换回 HWND 承载控件，`AllowsTransparency` 的分层窗口不能正常合成该子窗口，可能出现页面已加载但窗口内容不可见。歌词 renderer 保持透明背景与独立 CSS；原生 WPF 背景用 alpha 1/255，确保空白命中而不出现可见底板。启动与拖动结束按所在显示器工作区校正位置；原生输入需确认歌词／空白拖动、工具栏命中和锁定行为。

WebView2 的桌面歌词设置由 `windows-host/DesktopSettingsStore.cs` 独立保存，16KiB 文件上限，校验字体／颜色／字号／透明度与坐标。每次原子写入前保留上一份有效 `.bak`；主文件损坏时读取有效备份，两份均损坏或不可读时保留原文件并显示保存错误。设置仍可在当前会话使用，不能让退出时的默认状态覆盖损坏文件。

工具栏可见性由 `DesktopLyrics.tsx` 的定时器与 WebView2 bridge 的 `desktopLyrics.window.pointer` 事件共同控制，原生控制器检测窗口内指针，处理透明拖动区可能不派发 DOM 事件的情况。当前逻辑是指针在窗口内保持可见、离开后约 2200ms 隐藏；初次／焦点操作会显示。不要仅删除 CSS opacity、仅用 hover、给窗口开启整体鼠标穿透，或改成固定显示。

`.toolbar-hidden` 同时禁用 visibility 和 pointer-events，`.toolbar-visible` 恢复命中；错误提示 `pointer-events: none`，不能遮住设置栏。任何相关调整都要用真实 WPF/WebView2 窗口检查指针进入、下拉菜单操作、离开隐藏、再次进入、锁定解锁与拖动。静态截图只能证明外观。

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
3. 在主 renderer 根元素设置 `document.documentElement.dataset.theme`。新增保存字段需明确默认值、允许主题 ID、旧数据兼容，并沿用 `local-preferences.ts`／`ui-settings.ts` 与 `windows-host/LocalDataStore.cs` 的校验保存链路；不要创建另一套随安装目录变化的存储或接受任意 CSS 文本。
4. 主窗口的 WPF 背景与窗口设置在 `windows-host/MainWindow.xaml` 受控配置；需要运行时同步时只增加经过宿主校验的有限消息，不关闭隔离或给前台暴露任意原生 API。
5. 独立桌面歌词保持透明，决定是否仅更新工具栏，不套用主窗 body。主窗主题切换不改变音源、队列、歌词来源或时间校准。
6. 每个主题的状态与两种窗口尺寸均验收；新增持久化／IPC 需要相应业务回归。

### 新增桌面歌词字体或颜色

1. 在 `electron/desktop-lyrics-types.ts` 扩展 `DesktopLyricsSettings` 对应枚举，并向 `DESKTOP_LYRICS_FONT_OPTIONS` 或 `DESKTOP_LYRICS_COLOR_OPTIONS` 加选项。字体写完整 fallback，使用稳定 ID；勿重命名既有 ID 或改变其含义。
2. 同步 `windows-host/DesktopSettingsStore.cs` 的允许值校验。主设置页与歌词工具栏从同一数组渲染，不在一个界面手工添加不同配置。
3. 保留默认值与旧保存记录兼容；新增选项不能使旧文件读取失败。扩展字号／透明度范围时同步校验、主设置控件、工具栏限制和布局检查。
4. `DesktopLyrics.tsx` 自动从选项取得 fontFamily／color，通过 CSS 变量渲染，并在字体加载和尺寸变化后重新 fit。不要用 `!important font-size` 绕过自适应，长中文／英文句仍需完整显示。
5. 检查两窗设置同步、保存后重启恢复、缺字体 fallback，以及浅／深桌面上的描边与阴影。引入可分发字体时放在项目资源中并记录许可；系统字体文件不提交。

## 8. PC 与 Android 的统一规则

两端沿用米白／鼠尾草绿基色、唱片与封面元素、圆角卡片、按钮主次关系、歌词当前句的绿色高亮，以及加载／错误／空状态用语。PC 的当前字标是小写 `openmusic`（原名「余音 / YUYIN MUSIC」），手机版此次未改名，后续同步需在手机仓库单独实施。平台布局各自适配：PC 是侧栏与固定播放器，手机是触屏与安全区布局，不能直接复制 PC 宽度或拖窗规则。

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

按 [CONTRIBUTING.md](../CONTRIBUTING.md) 使用新建的绝对 `YUYIN_STATE_DIR` 和 `YUYIN_WEBVIEW2_USER_DATA_DIR`，不要在真实账号和存储上验收。用虚构歌曲、受控歌词／搜索响应；加载真实 Bilibili 内容的验证需独立说明范围。

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

提交说明写清改动文件、视觉效果、实际执行的验证与限制。记录浏览器预览、WPF/WebView2 受控响应、真实网络播放、原生输入这几类不同证据，不能把其中一种写成另一种已经通过。截图与日志不得包含个人昵称、头像、cookies、真实音乐库或签名信息。构建包及 `.qa/` 不提交源码；发布产物按版本进入 GitHub Release。
