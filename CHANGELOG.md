# 变更记录

## 0.9.46

同一份客户端代码也会在手机上运行（手机 GUI 走 bridge 代理），但手机没有 Electron `<webview>`，以前会一起轮询浏览器命令、一起上报页面状态，谁最后写入谁生效——桌面上的浏览器状态可能被手机端的空状态覆盖，命令也可能派给手机导致执行失败。

- 客户端启动时检测 `dshDesktop.browser` 能力（桌面 Shell 才有）：不具备该能力的客户端**不轮询浏览器命令、不上报 probe/page-state**，设置页等本地功能照常。
- probe/page-state 负载带 `panel: true`；宿主对 `panel: false` 的上报直接忽略（返回 `ignored: 'no-panel'`），作为第二道防线。
- 实测：伪造手机上报被忽略（返回 ignored），伪造桌面上报会被接受但 15 秒内被真实心跳覆盖回真实状态；真实心跳的周期性补发也验证有效。

## 0.9.45

- 做了一次「工具调用 ↔ 驱动方法」的静态契约审计：webview 的 HybridSession 覆盖全部 39 个被调用的方法；headless 在 0.9.44 补完后从 25 个增加到 52 个，连可选调用（`cancelQueued`、`diagnostics`、`setCallerSession`）也对上了，不再有「某工具在某个驱动下必然炸」的组合。
- headless 补 `cancelQueued`（无排队，返回 ok + note）。

## 0.9.44

修好了长期没被测过的 headless 驱动——它之前只能做最初那几个 CDP 动作，工具一多就 `TypeError: browser.x is not a function`：

- 新增 `lib/headless-compat.js` 兼容层：用 CDP 已有的能力补上 pageText / pageMarkdown / pageTables / waitFor / clickLocated / hoverAt / zoom / listTabs / barriers / refreshProbe / guardSession / consoleLogs / networkLogs / instrumentData / 诊断与历史清理等 24 个缺失方法；Cookie 快照、页面内下载、文件上传这些只有 webview 面板才有的能力返回明确的不支持提示，不再崩。
- 修 `clickRef` 的参数契约错位：工具把「确认」布尔值当第二个参数传，headless 当成 `clickCount` 发给 CDP，结果是 `Invalid parameters`，headless 下所有点击都失败。现在按 hybrid 的契约处理。
- 修 #mouse 的 CDP 参数：按下事件补 `buttons` 掩码、坐标裁到视口内，避免输入队列被无效事件卡死。
- `browser_doctor` 支持 headless 模式（不再要求「可见会话」，驱动显示为无头浏览器）。
- README 已知限制补 headless 的能力边界。

实测（driver=headless）：browser_open → snapshot → text → evaluate → wait → click（跳转到 iana.org）→ tabs list → doctor(ok) → console/cookies 返回明确提示；切回 webview 后 doctor 恢复 bridge 模式，测试用的 8 个残留 Chromium 进程已清理。

## 0.9.43

- 新增 `browser_doctor` 工具：一次检查多会话状态（发起会话归属、可见会话、自己有没有标签页、驱动模式、标签页数量、排队页、重放记录），出问题先跑它，返回 `verdict: ok|attention` 和逐项明细。它是只读诊断，跨会话也允许调用。
- 修「宿主插件重载后客户端像是断线」的问题：心跳以前只在数据变化时才 POST probe，宿主重启会清空 probe 状态，而页面数据没变就一直不补发，导致工具误判「客户端没连上」。现在每 15 秒（页面隐藏时 60 秒）至少补发一次，页面无需刷新就能重新接上。

## 0.9.42

- `browser_tabs` 新增 `action: cancel-queued`：可以取消某个会话排队中的页面（传 `session`），或清空整个排队（不传）。返回剩余排队数。之前只能去设置页点「取消」。
- README 的工具列表补上 `cancel-queued` / 跨会话归属说明。

## 0.9.41

- 文档更新（不改行为）：README 中英双语补「多会话与多工作区」一节，说明右侧栏归属、后台排队与切回自动打开、设置页的标签/排队管理、每会话页面记忆、headless 的每会话 profile 与实例上限；配置表补齐 `homeUrl`、`dataDir`、`restoreLastPage`、`profileRetentionDays`、`maxHeadlessBrowsers`。

## 0.9.40

- 隐藏会话也能用 CDP 能力了：当发起工具的那个会话有自己的标签页、只是目前看不到（你在看别的会话），并且这个页面的 URL 在所有会话里唯一时，CDP 允许附着到它——console 日志、网络历史、截图这些以前在后台会话里直接报「需要 CDP 驱动」的功能恢复可用。URL 有重复（两个会话开同一页）时仍然拒绝附着，避免认错页面。
- `browser_probe` 的 diagnose 增加 `viewStates`（每个 webview 的 sessionId / url / title），会话门就是靠它判断「是不是自己的页、URL 唯不唯一」。
- 子会话（自己没有标签页）仍然被拒绝，实测 `browser_console` 返回 `inactive-session`。

## 0.9.39

- `browser_tabs` 的 list 结果新增 `queued`（各会话排队中的页面：sessionId / url / 时间）和 `replays`（最近真实发生的排队重放记录），排查「切回会话没自动打开」时不用再猜。
- 排队重放只在真正执行打开时记录，不再每个心跳都写一条空记录。

## 0.9.38

- 每个会话记住自己最后打开的页面（`~/.dsh/katt-browser/session-pages.json`，由心跳的 page-state 按会话写入）。应用重启、标签页关掉再开、Ctrl+T 新建标签都恢复到该会话上次的页面，而不是永远回到 Bing 首页；首次使用才回到 `homeUrl`。
- `browser_open` 不带 url 时同样优先恢复该会话上次的页面。
- 新增配置 `restoreLastPage`（默认 true，设为 false 回到「总是首页」的行为）。
- 页面状态的客户端上报补 `session` 字段，宿主按会话归档；`browser_probe` 输出 `restoreLastPage` 与 `lastPages` 便于排查。

## 0.9.37

- 标签页列表补「上次查看」记忆：没有挂载 webview 的隐藏标签页，用最后一次被看到时的 URL/标题展示（`remembered: true`），设置页里也带「（上次查看）」标记。之前隐藏标签只有标题空白的一行会话 id。
- 修 `browser_tabs` 在「本会话没有自己的面板」时直接报「没找到浏览器面板」的问题：tabs / tab-close / sweep / probe / page-state 这些不依赖页面的操作不再要求先有挂载的 webview，跨会话清理标签恢复可用。
- 客户端跨会话放行名单与宿主侧对齐（之前宿主放行、客户端又拦下的情况）。

## 0.9.36

- 设置页「浏览器」分区新增「排队中的页面」：列出为其他会话排队的 URL（2 小时内有效），每条带「取消」按钮，可以直接放弃；状态行同步显示排队数量。
- headless 模式状态行显示实时实例数 `当前 N/上限`，来源是宿主 probe 的 `headlessInstances`。

## 0.9.35

- 设置页「浏览器」分区补状态行：当前驱动（侧栏 webview / 无头浏览器）、默认首页、headless 实例上限，一眼能看出这套浏览器现在跑在什么模式。
- 驱动信息来自宿主 probe 回复（`driver`、`maxHeadlessBrowsers`），不额外轮询。

## 0.9.34

- headless 驱动同时保留的浏览器实例上限（`maxHeadlessBrowsers`，默认 3）：超出按最久未使用淘汰并 dispose，避免常驻几十个 Chromium 进程。每会话 profile 不受影响，重新用时会按目录重建。
- 排队打开加 2 小时 TTL：切回那个会话时如果排队页已经过期就不再自动打开，避免几小时后突然冒出一个页面。

## 0.9.33

真实复现并修掉了「别的会话把页面开到我看的侧栏里」的最后一层原因：

- 缓存 CDP 附着会跨会话复用：A 会话建立的 CDP 连接，B 会话调用时直接拿来驱动 A 的页面。现在 `setCallerSession` 一旦发现发起会话变了就丢掉缓存附着，重新判断。
- CDP 附着的会话门改成 fail-closed：先刷新客户端上报的可见会话，只有「发起会话 == 屏幕上正在显示的会话」才允许 CDP；取不到可见会话时一律走 bridge。
- bridge 命令的 session 会真的带上：`sendCommand` 增加进程级兜底标记，`navigate` 显式传 `session`，不再出现 session 为空、客户端把命令落到可见面板的情况。
- 跨会话打开立即返回排队结果（`queued: true`），不再先等 15 秒两次再超时。
- `WebviewSession.navigate` 不再吞掉客户端拒绝结果：以前会把上一次的页面状态当成功返回，现在原样返回 `inactive-session`。
- 工具调用拿不到 initiator（无法确定属于哪个会话）时直接拒绝，不再默认操作可见面板。
- `browser_probe` 输出补 `callerSession` 和最近一次 navigate 的归属，便于排查。

## 0.9.32

- 设置页新增「浏览器」分区：列出所有会话的侧栏浏览器标签页（标题、会话 id、URL、是否属于当前可见会话），每行一个「关闭」按钮，可以直接清掉别的会话里遗留的标签，不用切过去手动关。
- 该分区每 3 秒自动刷新，和 `browser_tabs` 工具看到的是同一份数据。

## 0.9.31

- `browser_tabs` 变成跨会话的标签页管理器：list 返回每个标签页的 `sessionId`、`visible`（是否属于当前屏幕上的会话）、标题和 URL；别的会话里遗留的标签页可以直接 close 掉。之前只列当前面板、看不出归属。
- 跨会话时 `browser_tabs` 不再被会话守卫拦掉（列清单/清标签本来就是跨会话操作），`browser_open` / `browser_open_file` 继续走后台打开。

## 0.9.30

- 每会话 headless profile 会累积（一个浏览器一个目录），启动时按 `profileRetentionDays`（默认 14 天）清理旧的会话目录；0 = 不清理。避免长期使用把磁盘塞满。

## 0.9.29

- CDP 附着加会话门：只有发起工具的那个会话正是屏幕上显示的那个时，才用 CDP 直连（CDP target 只有 URL/title，两个会话开同一网址时分不清）；后台会话一律走 bridge，命令带 session 由客户端定位自己会话的 webview。
- 打开本地文件也带会话：客户端把当前可见会话 id 发给 `/api/katt-browser/open-file`，宿主先设置 callerSession 再打开，后台会话打开文件不会落到别人的面板。
- `browser_open_file` 和 `browser_open` 一样允许后台打开（通过 openTabIn 落到发起会话自己的标签页）。

## 0.9.28

- headless 驱动改成**每会话一个浏览器实例**：profile 落在 `dataDir/sessions/<sessionId>`，Cookie、历史、滚动位置、页面状态互不共享。以前所有会话共用同一个无头浏览器，A 的登录态和页面会漏给 B。
- 快照引用按会话隔离：`snapshot` 的元素表按发起会话存，`click ref` 只查自己会话的表，不会拿 A 的 eN 去点 B 的页面。

## 0.9.27

- 后台打开不再排队：用 `sidebarRight.openTabIn(sessionId, 'browser', {params:{url}})` 直接在发起工具的那个会话里开标签页，页面立即在后台加载（隐藏），切回该会话时已经是加载好的页面。
- 该会话已经有自己的隐藏 webview 时直接导航它，不碰别人的面板；`openTabIn` 不可用或失败才退回排队。
- 宿主守卫同步放宽：`browser_open` 允许进入后台路径；其它需要面板输入的工具仍然拒绝跨会话。

## 0.9.26

- 跨会话串台修复（真根因）：浏览器查找从「页面里第一个 webview」改为「属于发起工具那个会话的 webview」。以前隐藏会话和当前会话的面板同时挂载时，工具会抓到别的会话的 webview 并导航它，或者 `openTab` 把标签页开在当前活动会话里。
- 后台打开的排错路径：如果发起工具时那个会话的右侧栏不可见，`browser_open` 不再硬开在别人的面板里，而是把 URL 排队（`queueOpen`）；等你切回那个会话时自动打开。
- `openTab` 后按新标签页的 sessionId 核对，开错会话的标签会被立即关掉。
- 宿主侧强制注入 `agents` 服务，工具调用一定带得上发起会话 id（以前只是可选获取，拿不到时守卫等于失效）。

## 0.9.25

- 地址栏支持搜索：输入网址就打开网址，输入普通文字就用 Bing 搜索（和 Edge 地址栏同一逻辑）。判定规则——带协议/`//`/localhost/IP/形如 `a.b` 的主机名走导航，其余（单个词、带空格的话）走 `https://www.bing.com/search?q=…`。
- 拦截地址栏回车和「前往」按钮两处提交，工具里的 `browser_open` 也走同一个解析函数，不再把 "bing" 当成域名去解析。

## 0.9.24

- 「浏览器」命令（Ctrl+T 走同一条路径）默认打开配置的首页（默认 Bing），不再是空白引导页：给 `sidebarRight.openTab('browser', …)` 注入 `params.url`，并在新标签页停在引导页时自动填写地址、点「前往」。
- 只处理还没有 webview 的引导页标签，已经加载页面的浏览器标签不会被改动。
- 首页值来自 Host 的 `homeUrl` 配置，通过 probe 回包下发给客户端。

## 0.9.23

- 修复跨会话串台：侧栏浏览器属于某个会话，工具调用现在带上发起者会话；当面板/浏览器标签属于另一个会话时，工具直接返回 `inactive-session`，不再导航、不再展开、也不再在别人的会话里开标签页。
- 判定依据是「要驱动的那个 webview 属于哪个会话」（`data-sidebar-right-session` 祖先），没有 webview 时退回到用户当前正在看的右侧栏；同时客户端会立即关掉误开在别的会话里的浏览器标签页。
- headless 驱动不受影响——它本来就不碰侧栏面板。

## 0.9.22

- 默认首页：新增配置 `homeUrl`（默认 `https://www.bing.com`）。`browser_open` 不传 url 时打开它；headless 驱动启动时的首页也用它。
- 侧栏浏览器刚打开、还停在 `about:blank` 时，第一次工具操作会先落到默认首页，不再留一个空白面板。
- 顺手把 `browser_open` 的参数必填列表去掉 url，模型可以只喊一句「打开浏览器」。

## 0.9.21

- 配置项 `dataDir` 正式暴露：headless 驱动的浏览器 profile 目录（默认 `~/.dsh/katt-browser`）。登录一次后跨重启保留，换目录等于换一套浏览器身份。侧栏 webview 驱动继承 DSH 的非持久分区，登录态不跨重启，需要长期登录请用 `driver: headless`。

## 0.9.20

- `browser_click` 的 selector/text 定位现在会验证点击是否真的落地：先发真实鼠标事件，用一次性的 capture 监听确认；没命中就退回 `element.click()`，返回 `realInput:false` + `fallback:"dom-click"`。不再出现「返回成功但页面没反应」。

## 0.9.19

- 修复 `browser_wait`：等待表达式里的正则转义写坏（`//+$/`），实际每次求值都抛异常；改成不用正则的尾斜杠裁剪。
- `browser_click` 的 selector/text 定位补上「面板收起」守卫：收起时返回 panelHidden 提示，而不是静默点空。

## 0.9.18

- 新增 `browser_wait`：等选择器出现 / 正文包含文字 / URL 前缀匹配，任一满足即返回，超时给出最后一次没命中的原因。学自 dsh-browser-bridge。
- `browser_click` 现在支持 `selector` 和 `text`（可见文字）两种定位，不必先 snapshot 拿 ref；CDP 下走真实鼠标，桥驱动退回 element.click()。
- `browser_text` 新增 `format: markdown`：保留标题层级、链接、列表、表格、代码块，整理资料时更省 token。

## 0.9.17

- 删掉文档预览标题栏的「Katt 浏览器」按钮：这个槽位对所有预览文件都会出现（连 .py 都挂），既然 html 已经在 `openResource` 层统一接管，按钮就是多余的。开关入口只剩「点文件本身」。

## 0.9.15

- **所有入口的 html 都改走插件浏览器**：包装了侧栏标签服务的 `openResource`（会话里的文件链接、@ 引用、文件树、交付物、技能引用都会经过它），把 `dsh-resource://file/...` 地址解析成绝对路径；`.html` / `.htm` 直接起本地服务并在插件浏览器打开，其它文件仍走内置预览。
- 地址解析同时支持 session 作用域（相对工作目录）和 absolute 作用域，取 session 的 cwd 拼成绝对路径。

## 0.9.14

- 文件列表的 html 行打开按钮是一个包着文件名的 `<button>`，0.9.13 的拦截把它当成「行内操作按钮」跳过了，所以真实点击仍进预览。现在改成：只要按钮里包着文件名就拦；pointerdown 和 click 都拦，防止宿主抢先打开预览。
- 行内其他操作按钮（菜单之类）保持原行为。

## 0.9.13

- **工作区的 html 默认就用这个浏览器打开**：在右侧栏「文件」列表里点 `.html`/`.htm`，不再进内置的沙箱预览，而是自动起本地服务、在侧栏浏览器里打开并切过去。行内的按钮（比如在系统浏览器打开）保持原行为，`.md`、`.pdf` 等其他文件不受影响。
- 预览页标题栏的「Katt 浏览器」按钮保留，给已经打开预览的情况用。

## 0.9.12

- `browser_open_file` 和预览页的「Katt 浏览器」按钮现在会顺手把右栏切到浏览器标签并展开：之前文件确实打开了，但右栏还停在文档预览上，看起来像没反应。

## 0.9.11

- **工作区的 html 也能让 agent 看了**：文档预览的标题栏多一个「Katt 浏览器」按钮，点一下就把当前文件用本地静态服务映射成 http://127.0.0.1 地址、在侧栏浏览器里打开——原生预览是沙箱 iframe，没有 CDP 后端，点了也操作不了；换到这个浏览器之后 snapshot/click/evaluate 全部可用。
- 新增工具 `browser_open_file`：给一个路径，自动起服务并打开，省掉 browser_serve + browser_open 两步。
- 新增宿主路由 `/api/katt-browser/open-file`（按钮和工具共用），自动选 7810–7899 里空闲的端口。

## 0.9.10

- **零配置**：右侧栏收起、甚至还没有浏览器标签页时，第一次调用 browser_open / browser_snapshot 会自动展开右栏并把页面挂上；点击、输入、按键前也会先刷新面板状态，收起时自动展开一次（10 秒内不重复抢面板）。新增配置 `autoReveal`（默认开，设 false 恢复旧行为：只返回 panelHidden 提示）。
- 修了面板收起时状态判断错误导致「看起来能点、实际点空」的问题（收起后 viewport 是 1×1，之前被当成可见）。
- 多标签页时，自动展开会按目标 URL 切到对应标签，不会把输入发到别的页。

## 0.9.9

- 侧栏浏览器加载时不再显示居中的「正在打开…」占位文字：加载态改为地址栏右侧的小圆环转圈（Chrome 风格），加载结束自动消失。实现是注入一条样式 + MutationObserver，只改表现，不改内置组件。

## 0.9.8

- **compact 不再返回空**：div 拼的页面（课程站、后台）没有 ARIA 角色时，自动补 DOM 可点击候选（cursor:pointer / onclick / tabindex / aria-expanded），并附一段正文文本和 note 说明；实在没有结构时退回正文。CDP 和桥两条通道都支持。
- **提示词优先结构**：`browser_snapshot` 说明更适合拿页面信息，`browser_screenshot` 改成「最后手段」——只有结构表达不了视觉（canvas/图片/排版）或结构通道失效时才截图。
- **页面切换动画**：去掉整页压暗和模糊（合成开销大、像闪一下），改成 Chrome 式顶部 2px 进度条（双段扫过），新页面淡入从 0.22s/35% 改成 0.12s/86%。
- 修了 DOM 候选扫描里读取 CDP 返回值的写法，扫描失败时会把原因带进快照结果（`domScanError`），方便排查。

## 0.9.7

- 新增 `browser_zoom` 工具：in/out/reset/set，范围 0.25~5 倍，走 webview 的页面缩放（和 Ctrl+= 同一套，布局重排而不是整页拉伸）；没有 webview 通道时退回 CDP 的 page scale / CSS zoom。
- `browser_state` 返回当前缩放倍数；`browser_probe` 报告 `setZoomFactor/getZoomFactor` 能力。

## 0.9.6

- 剪贴板补丁改成**双路径**注入：CDP 附着时走 `Page.addScriptToEvaluateOnNewDocument`，没附着时由渲染进程在页面就绪/心跳时注入。这样插件刚重载、或者用户只是自己点页面按钮复制，也能复制成功。

## 0.9.5

- **修复内置浏览器复制失效**：DSH 给侧栏浏览器的 session 把权限请求全部拒绝（`setPermissionRequestHandler(callback(false))`），所以 `navigator.clipboard.writeText` 一律 `NotAllowedError`，GitHub 这类"点按钮复制"因此到不了系统剪贴板。注入脚本现在把异步 Clipboard API 改走 `execCommand('copy')`（实测能落到系统剪贴板），按钮复制恢复正常；面板收起时同样有效。

## 0.9.4

- **卡顿优化**：去掉常驻的 `Emulation.setFocusEmulationEnabled`（之前一直开着会让隐藏的 webview 不给 Chromium 节流，浏览器面板一直按 144Hz 出帧）。现在只在点击/输入时开 4 秒。
- **空闲自动断开 CDP**：45 秒没有浏览器操作就 detach，下次操作自动重连；新增 `cdpIdleDetachMs` 配置（0 = 保持连接）。实测 UI 渲染进程 115% → 106.9%，GPU 50.6% → 43.9%。
- **心跳降频**：2.5 秒 → 8 秒，数据没变化或窗口不可见时不发请求。
- **插桩瘦身**：只对 ≤256KB 的 JSON 响应取预览，不再克隆 JS/文本响应；新增 `instrument` 开关（重页面可关）。
- `browser_probe` 改为实时探测，不再拿缓存导致误报。

## 0.9.2

- **危险操作确认**：`browser_click` 命中「删除/支付/注销/解绑…」这类按钮时，不传 `confirm=true` 只返回 `needsConfirm` 提示，不会真的点。实测：点「删除这条记录」→ 拦截；`confirm=true` 再点 → 页面状态变为 deleted。
- **站点适配器**：本轮未做（低频需求，先靠通用工具）。

## 0.9.1（P2 批次）

- **快照分级**：`browser_snapshot` 支持 `detail=compact`（只给交互元素，省 token）和 `full`（默认）。
- **操作日志**：`browser_history` 记录导航/点击/输入/标签/上传/Cookie 操作，支持 clear。
- **Cookie 加密**：profile 快照改为 AES-256-GCM 加密写入（`katt-profile-1` 格式），密钥在 `~/.dsh/katt-browser/profile.key`（32 字节）；旧明文快照仍可读，下次保存自动加密。
- **断线自愈**：CDP 命令失败时立即 drop 连接并清冷却，下次调用立刻重新 attach（不再等 30 秒）。
- **域名白名单**：`allowedHosts` 配置项，非空时只允许这些域名及子域，实测 example.com 被拦、quotes.toscrape.com 放行。

## 0.9.0（P0/P1 批次）

- **多标签管理**：`browser_tabs` 支持 `list / switch / new / close`，切换后自动重新绑定 CDP 目标。实测：新建 example.com 标签 → 切换（状态变 example.com）→ 关闭 → 切回原标签。
- **控制台日志**：`browser_console` 抓 `console.*`、未捕获异常、`Log.entryAdded`，支持按级别过滤和清空。实测两条日志（log/warning）都读到。
- **网络历史**：`browser_network` 记录请求方法/URL/状态码/MIME/来源/耗时，支持 URL 过滤和清空。实测 fetch 200，耗时 908ms。
- **交互补全**：`browser_hover`（悬停）、坐标点击、`browser_upload`（文件上传，实测 input.files 拿到文件名）、`scrollIntoView`。
- **结构化提取**：`browser_text`（正文 + 标题 + 链接，去导航/页脚）；`browser_table`（表头 + 行数据，实测 w3schools 两个表）。
- 版本 0.9.0，工具总数 24 个。

## 0.8.4

- **不会再闪「正在打开」标签页**：同标签策略在页面脚本之前注入并加固——`window.open(url)` 直接同标签跳转、`window.open()` 后赋 `location` 的写法用 Proxy 兜住、`<a>` 的编程式 `click()` 与 `form.submit()` 都强制 `_self`。
- **过渡动画**：程序化导航和弹窗折回时先给旧页面加一层暗化 + 顶部进度条（140–260ms），再切换；每个新页面淡入（220ms，`__kattFadeIn`）。
- 实测：4399 点分类链接（原本会开新标签），改造前后 webview 目标数 1 → 1，URL 原地变为 `/special/19.htm`。

## 0.8.3

- **IndexedDB 分页快照**：不再被 `idbLimit` 截断。按游标分页拉取，`idbLimit` 变成每页条数，单库上限 500 条，`profiles`/`save` 返回实际条数。
- 实测：120 条记录的库（默认每页 50）完整保存；删库后 `load` 恢复 120 条，profile 文件 21.7KB。

## 0.8.2

- **Cache Storage 进快照**：快照收集 `caches` 内容（单个响应 ≤256KB、总量约 1.5MB、每个 cache ≤25 条），`load` 时用 `cache.put` 重建；保存/列举会显示 `cacheEntries`。
- 修复：`restoreStorage` 的 payload 没带 `caches`，导致缓存还原静默失效。
- 实测：自建 `katt-cache` 一条 JSON，删缓存后 load 恢复（正文逐字节一致）。
- **验证码提醒实测**：reCAPTCHA 演示页返回 `kind: captcha` + 手动操作建议。

## 0.8.1

- **Config schema**：导出 `Config`（driver/cdpPort/idbLimit/downloadDir），依赖用插件目录 `node_modules` junction 解析 schemastery。
- **browser_serve**：本地 HTTP 静态服务，解决 `file://` 打不开的问题；支持 start/stop/list，插件卸载时自动停止。
- **IndexedDB 上限可配**：`idbLimit` 从常量变成配置项，默认 50。
- **反爬提醒**：`browser_state` / `browser_open` 返回 `barriers`，识别登录墙、验证码/滑块、限流，并给出「需要用户手动操作」的明确建议（知乎实测正确归类为 login）。

## 0.8.0

这一版把「内置浏览器」从能用做到可封测：结构读取为主、截图兜底，Cookie/缓存的共享与隔离成体系。

### 驱动
- CDP 驱动上线：附到侧栏 webview guest 上直连 DevTools 协议，AX 快照带 `eN` ref、真实鼠标/键盘输入、`Page.captureScreenshot`。
- JS 桥降级：CDP 端口不存在时自动退回页面内 webview 桥（DOM 枚举快照），命令通道改 HTTP 长轮询，插件热重载后 4–6 秒自愈。
- attach 冷却修正：只有「CDP 端口不存在」才冷却 30 秒；导航瞬间 guest 未就绪不再误伤。
- 弹窗折回：`Target.targetCreated`/`targetInfoChanged` 把 `window.open` 的新窗口 URL 折回当前标签并关掉多余 target，面板不再堆重复标签。

### 读取（不靠截图）
- `browser_snapshot`：AX 树，覆盖 iframe、Shadow DOM（shoelace 164 个 shadow host 实测）。
- `browser_evaluate`：DOM/JS/存储直读。
- `browser_instrument`：页面加载前注入，抓 Worker 消息（2048 的 score/board）、fetch/XHR/WebSocket（bing 补全接口）、storage 写入。
- `browser_open` 的 `waitFor`/`waitMs`：SPA 水合延迟用选择器等待解决（B站首页 27 个视频链接）。

### 账号与缓存
- 分区机制查清：侧栏浏览器用 `dsh-sidebar-browser-<uuid>` 非持久化 partition，按 workspace 分配；同 workspace 全共享，换 workspace 窗口即隔离。
- `browser_cookies`：`list/save/load/clear/clear-site/clear-cache/profiles`，快照含 Cookie + localStorage/sessionStorage + IndexedDB（带主键，每库 50 条）。
- 登录态闭环实测：the-internet 登录 → 存快照 → 清 Cookie 被踢出 → load 快照重回登录态。
- `clear-site` 实测清掉 Service Worker、cache storage、IndexedDB（squoosh.app）。

### 其他
- `browser_download`：侧栏原生下载被壳禁用，改页面内 fetch 取字节、宿主落盘。
- `browser_probe` 输出驱动诊断（模式/target/端口/失败时间）与分区名。
- 模块拆分：`lib/cdp.js`（协议）、`lib/hybrid.js`（编排）、`lib/profiles.js`（快照）、`lib/webview.js`（桥）。
- 站点实测：bing、4399、2048、quotes.toscrape、16personalities、w3schools iframe、react.dev、httpbin、squoosh、shoelace、the-internet、豆瓣、知乎、B站。

### 已知边界
- `file://` 打不开（`ERR_FAILED`）。
- 侧栏原生下载被禁用。
- Service Worker 脚本与 cache storage 只支持清除，不进快照。
- 插件暂未导出 Config schema（`@deepseek-ai/schemastery` 在插件目录解析不到）。
