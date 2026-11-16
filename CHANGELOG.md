# 变更记录

## 0.9.7

- 新增 `browser_zoom`：in/out/reset/set，0.25~5 倍，用 webview 页面缩放（布局重排，不是整页拉伸）；没有 webview 通道时退回 CDP page scale / CSS zoom。
- `browser_state` 返回实际缩放倍数，`browser_probe` 报告缩放能力。

## 0.9.6

- 剪贴板补丁改成双路径注入：CDP 附着时用 `Page.addScriptToEvaluateOnNewDocument`；没附着时由渲染进程在页面就绪/心跳时注入。插件刚重载或用户只是自己点按钮复制也能生效。

## 0.9.5

- **修复内置浏览器复制失效**：DSH 给侧栏浏览器 session 把所有权限请求都拒绝了，`navigator.clipboard.writeText` 一律 `NotAllowedError`，GitHub 这类按钮复制到不了系统剪贴板。注入脚本把异步 Clipboard API 改走 `execCommand('copy')`，按钮复制恢复正常，面板收起时也有效。

## 0.9.4

- **卡顿优化**：去掉常驻的焦点模拟（此前让隐藏的 webview 不被 Chromium 节流，面板一直按 144Hz 出帧）；空闲 45 秒自动断开 CDP，下次操作自动重连（`cdpIdleDetachMs`，0 = 保持连接）。实测 UI 渲染进程 115% → 106.9%，GPU 50.6% → 43.9%。
- **心跳降频**：2.5 秒 → 8 秒，数据没变化或窗口不可见时不发请求。
- **插桩瘦身**：只对 ≤256KB 的 JSON 响应取预览，不再克隆 JS/文本响应；新增 `instrument` 开关。
- `browser_probe` 改为实时探测，避免缓存导致的误报。

## 0.9.3

- **修复：工具操作会抢别的会话的右侧栏**。原因是 CDP 对齐逻辑每次操作都调 `focus`，客户端 `focus` 里 `expandRightbar()` + `activateTab()`；桥模式还会 `ensureVisibleWebview` 里 `openRightbar`。现在默认完全不主动展开/切换面板，新增配置 `revealPanel`（默认 `false`）给需要展开的场景。
- **面板收起时的行为**：读页面（快照/文本/console/网络/Cookie）和导航照常；真实点击/输入无法作用于隐藏的 guest，改为返回 `panelHidden` 提示而不是静默失败。
- `browser_probe` 增加 `revealPanel` 字段，方便确认当前策略。

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
