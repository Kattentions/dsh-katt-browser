/**
 * katt-browser — host half.
 *
 * Owns one Chromium page that both the user (through the Web UI panel) and the
 * agent (through tools) operate. The page is a real, visible-to-nobody headless
 * Edge instance driven over CDP; the panel receives a screencast and forwards
 * real mouse/keyboard input, so both sides act on the same document, the same
 * cookies and the same scroll position.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebviewSession } from './lib/webview.js';
import { HybridSession } from './lib/hybrid.js';
import { listServe, startServe, startServeAuto, stopAllServe, stopServe } from './lib/serve.js';
import z from '@deepseek-ai/schemastery';

/** Plugin configuration (declared so the DSH settings layer can validate it). */
export const Config = z.object({
  driver: z.union([z.const('webview'), z.const('headless')]).default('webview'),
  cdpPort: z.natural().default(9222).description('DevTools 调试端口；启动参数需带 --remote-debugging-port'),
  idbLimit: z.natural().default(50).description('每个 IndexedDB 库快照保存的记录条数上限'),
  downloadDir: z.string().description('browser_download 的默认保存目录（默认 用户目录/Downloads/katt-browser）'),
  dataDir: z.string().description('headless 驱动的浏览器 profile 目录（默认 ~/.dsh/katt-browser）；里面保存登录态，换目录等于换一套浏览器身份'),
  allowedHosts: z.array(z.string()).description('域名白名单；非空时只允许访问这些域名及其子域'),
  revealPanel: z.boolean().default(false).description('工具操作时是否主动展开右侧栏（默认 false，避免抢当前会话的面板）'),
  autoReveal: z.boolean().default(true).description('面板收起时，第一次点击/输入自动展开一次（默认开；false = 只返回提示）'),
  instrument: z.boolean().default(true).description('是否注入页面插桩（worker/fetch/XHR/WebSocket）；重页面可关掉以减少开销'),
  cdpIdleDetachMs: z.natural().default(45000).description('空闲多少毫秒后断开 CDP（默认 45000；0 = 一直保持连接）。断开后下次操作会自动重连，避免长时间附着影响 Chromium 渲染节流'),
  homeUrl: z.string().default('https://www.bing.com').description('没有指定页面时默认打开的网址（默认 Bing）；browser_open 不带 url、headless 启动的首页都用它'),
});

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'katt-browser');
const SHOT_DIR = path.join(os.tmpdir(), 'katt-browser-shots');
const DEFAULT_HOME = 'https://www.bing.com';

const ROUTE_STREAM = '/api/katt-browser/stream';
const ROUTE_PULL = '/api/katt-browser/pull';
const ROUTE_STATE = '/api/katt-browser/state';
const ROUTE_ACTION = '/api/katt-browser/action';
const ROUTE_INPUT = '/api/katt-browser/input';
const ROUTE_HELLO = '/api/katt-browser/client-hello';
const ROUTE_VISIBILITY = '/api/katt-browser/visibility';
const ROUTE_FRAME = '/api/katt-browser/frame';
const ROUTE_CONFIG = '/api/katt-browser/config';
const ROUTE_RESULT = '/api/katt-browser/result';
const ROUTE_PAGE_STATE = '/api/katt-browser/page-state';
const ROUTE_PROBE = '/api/katt-browser/probe';
const ROUTE_OPEN_FILE = '/api/katt-browser/open-file';

/**
 * Open a workspace file in the sidebar browser. The webview refuses file://
 * (ERR_FAILED), so the file's directory is served on loopback first and the
 * browser navigates to http://127.0.0.1:<port>/<name>.
 * @param {string} target - absolute path of a file or directory.
 * @param {object} browser - hybrid session.
 * @returns {Promise<object>} { ok, url, root, file } or { error }.
 */
async function openLocalFile(target, browser) {
  const filePath = path.resolve(String(target || ''));
  let stat = null;
  try { stat = statSync(filePath); } catch { return { error: '路径不存在：' + filePath }; }
  if (stat.isDirectory()) {
    const served = await startServeAuto(filePath);
    if (served.error) return served;
    const url = served.url;
    await browser.navigate(url);
    try { await browser.reveal?.(url); } catch { /* reveal is best effort */ }
    return { ok: true, url, root: filePath, kind: 'directory' };
  }
  if (!stat.isFile()) return { error: '不是普通文件：' + filePath };
  const directory = path.dirname(filePath);
  const served = await startServeAuto(directory);
  if (served.error) return served;
  const base = served.url.replace(/\/+$/, '');
  const url = base + '/' + encodeURIComponent(path.basename(filePath));
  await browser.navigate(url);
  try { await browser.reveal?.(url); } catch { /* reveal is best effort */ }
  return { ok: true, url, root: directory, file: filePath, kind: 'file' };
}

const ENUM_FN = `
function kattList() {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick]';
  const seen = new Set();
  const list = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
    if (el.disabled) continue;
    list.push(el);
  }
  return list;
}
function kattLabel(el) {
  const raw = el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
  return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 90);
}
`;

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

function resolveExecutable(configured) {
  if (configured && existsSync(configured)) return configured;
  for (const candidate of EDGE_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

function preflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, CORS_HEADERS);
  res.end();
  return true;
}

class BrowserSession {
  constructor(config) {
    this.config = config;
    this.dataDir = config.dataDir || DEFAULT_DATA_DIR;
    this.pageFile = path.join(this.dataDir, 'last-page.json');
    this.executable = resolveExecutable(config.executablePath);
    this.child = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
    this.listeners = new Map();
    this.clients = new Set();
    this.starting = null;
    this.state = { url: 'about:blank', title: '', loading: false, ready: false, error: null, viewport: { width: 1024, height: 720 } };
    this.screencastOn = false;
    this.lastFrame = null;
    this.frameCount = 0;
    this.hello = null;
    this.lastRevealAt = 0;
    // Surfaces report whether the panel is actually on screen. A JPEG screencast is the
    // expensive part of this plugin, so it only runs while somebody can see it.
    this.visibleSurfaces = new Map();
    this.visibilityAware = false;
    this.lastActivityAt = Date.now();
    this.idleTimeoutMs = Number(config.idleTimeoutMs) > 0 ? Number(config.idleTimeoutMs) : 10 * 60 * 1000;
    // A hidden panel leaves a whole headless browser resident; close it once nobody has
    // touched it for a while so the process does not camp on hundreds of megabytes.
    this.idleTimer = setInterval(() => { this.#idleCheck(); }, 60000);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  #idleCheck() {
    if (!this.sessionId || this.visibleSurfaces.size > 0) return;
    if (Date.now() - this.lastActivityAt < this.idleTimeoutMs) return;
    this.hardClose().catch(() => {});
  }

  /* ------------------------------------------------------------ lifecycle */

  async ensure() {
    this.touch();
    const live = this.sessionId && this.ws && this.ws.readyState === 1;
    if (live) return this;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start() {
    if (!this.executable) throw new Error('找不到 Edge 可执行文件，请在插件配置里设置 executablePath');
    this.disposed = false;
    this.startedAt = Date.now();
    mkdirSync(this.dataDir, { recursive: true });
    const portFile = path.join(this.dataDir, 'DevToolsActivePort');
    // A plugin reload or a Host restart leaves the previous Chromium alive: adopt it
    // instead of spawning a second instance with the same profile, so the page the
    // user is looking at survives.
    if (await this.#adopt(portFile)) return this;
    // An adopted-then-killed browser can leave a headless Edge holding this profile;
    // a second instance on the same profile would fail, so reap before spawning.
    this.#killProfileProcesses();
    try {
      if (existsSync(portFile)) writeFileSync(portFile, '');
    } catch {}
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-accelerated-2d-canvas',
      '--disable-dev-shm-usage',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--renderer-process-limit=1',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.dataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--mute-audio',
      'about:blank',
    ];
    this.child = spawn(this.executable, args, { stdio: 'ignore', windowsHide: true });
    this.childPid = this.child.pid;
    this.child.on('exit', () => {
      this.#teardown();
    });
    const deadline = Date.now() + 20000;
    let port = null;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const content = readFileSync(portFile, 'utf8').trim();
        if (content.includes('\n')) {
          port = Number(content.split('\n')[0]);
          if (port > 0) break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new Error('Chromium 调试端口没有就绪');
    await this.#connectBrowser(port);
    await this.#wirePage(true);
    await this.#ensureHome();
    return this;
  }

  async #connectBrowser(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
    });
    this.ws.onmessage = (event) => this.#onMessage(event);
    this.ws.onclose = () => this.#teardown();
  }

  async #wirePage(createIfMissing) {
    let targetId = this.targetId;
    if (!targetId) {
      const targets = await this.send('Target.getTargets');
      const infos = (targets.targetInfos || []).filter((target) => target.type === 'page');
      const internal = (url) => /^(chrome-extension|extension|chrome|edge|devtools|about):/i.test(String(url || ''));
      // An adopted browser may have stray tabs (an extension's welcome page is common);
      // reattach to the page this plugin was last showing instead of the first tab.
      let remembered = null;
      try { remembered = JSON.parse(readFileSync(this.pageFile, 'utf8')); } catch {}
      const rememberedTarget = remembered && infos.find((target) => target.targetId === remembered.targetId);
      const rememberedUrl = !rememberedTarget && remembered
        ? infos.find((target) => target.url === remembered.url)
        : null;
      const page = rememberedTarget
        || rememberedUrl
        || infos.find((target) => /^(file|about):/i.test(target.url) && !internal(target.url))
        || infos.find((target) => !internal(target.url) && /^https?:/i.test(target.url))
        || infos.find((target) => !internal(target.url))
        || infos[0];
      targetId = page ? page.targetId : undefined;
    }
    if (!targetId) {
      if (!createIfMissing) throw new Error('没有可用的页面 target');
      const created = await this.send('Target.createTarget', { url: 'about:blank' });
      targetId = created.targetId;
    }
    this.targetId = targetId;
    const attached = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = attached.sessionId;
    // A background tab ignores synthesized scroll gestures in headless Chromium.
    await this.send('Target.activateTarget', { targetId }, undefined).catch(() => {});
    // A reload/restart re-wires the same page, so previous bindings must not stack up.
    this.listeners.clear();
    this.screencastOn = false;
    await this.send('Page.enable', {}, this.sessionId);
    await this.send('Runtime.enable', {}, this.sessionId);
    await this.send('Log.enable', {}, this.sessionId);
    await this.send('Emulation.setDeviceMetricsOverride',
      { width: this.state.viewport.width, height: this.state.viewport.height, deviceScaleFactor: 1, mobile: false },
      this.sessionId);
    this.bindPageEvents();
    this.state.ready = true;
    this.state.error = null;
    this.state.loading = false;
    try {
      const info = await this.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ url: location.href, title: document.title })',
        returnByValue: true,
      }, this.sessionId);
      const parsed = JSON.parse(info.result.value);
      if (parsed.url && parsed.url !== 'about:blank') this.state.url = parsed.url;
      if (parsed.title) this.state.title = parsed.title;
    } catch {}
    this.#rememberPage();
    this.#broadcast({ type: 'ready', state: this.state });
    // A panel that connected while the browser was still starting has no screencast yet.
    if (this.clients.size > 0) {
      this.#ensureScreencast().catch(() => {});
      this.captureFrame().catch(() => {});
    }
  }

  async #adopt(portFile) {
    try {
      if (!existsSync(portFile)) return false;
      const firstLine = readFileSync(portFile, 'utf8').trim().split('\n')[0];
      const port = Number(firstLine);
      if (!Number.isInteger(port) || port <= 0) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      let version;
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })).json();
      } finally {
        clearTimeout(timer);
      }
      if (!version || !version.webSocketDebuggerUrl) return false;
      await this.#connectBrowser(port);
      await this.#wirePage(true);
      await this.#ensureHome();
      this.adopted = true;
      return true;
    } catch {
      try { this.ws?.close(); } catch {}
      this.ws = null;
      this.sessionId = null;
      this.targetId = null;
      this.pending.clear();
      return false;
    }
  }

  #rememberPage() {
    try {
      writeFileSync(this.pageFile, JSON.stringify({ targetId: this.targetId, url: this.state.url || '' }), 'utf8');
    } catch {}
  }

  #teardown() {
    this.state = {
      ...this.state,
      ready: false,
      loading: false,
      error: this.disposed ? null : 'browser exited',
    };
    this.sessionId = null;
    this.ws = null;
    this.pending.clear();
    this.screencastOn = false;
    this.listeners.clear();
    this.#broadcast({ type: 'closed' });
    if (!this.disposed && this.child && !this.child.killed) {
      try { this.child.kill(); } catch {}
    }
    if (!this.disposed) this.child = null;
  }

  async #ensureHome() {
    if (!this.sessionId) return;
    const home = typeof this.config.homeUrl === 'string' && this.config.homeUrl ? this.config.homeUrl : DEFAULT_HOME;
    const current = String(this.state.url || '').trim();
    if (!home || (current && current !== 'about:blank')) return;
    try {
      this.state.loading = true;
      this.state.url = home;
      await this.send('Page.navigate', { url: home }, this.sessionId);
      this.#broadcast({ type: 'state', state: this.state });
    } catch {}
  }

  dispose() {
    // Leaving the browser alive keeps the page (and its login state) available for the
    // next activation, which adopts the same process. Use hardClose() to really stop it.
    this.disposed = true;
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    this.state = { ...this.state, ready: false, loading: false, error: null };
    for (const client of this.clients) {
      try { client.end(); } catch {}
    }
    this.clients.clear();
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.sessionId = null;
    this.pending.clear();
    this.screencastOn = false;
    this.listeners.clear();
  }

  async hardClose() {
    try { await this.send('Browser.close'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.sessionId = null;
    this.pending.clear();
    this.screencastOn = false;
    this.listeners.clear();
    const pid = this.childPid;
    if (pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.#killProfileProcesses();
    this.child = null;
    this.childPid = null;
    this.adopted = false;
    this.state = { ...this.state, ready: false, loading: false, error: null };
    try { rmSync(path.join(this.dataDir, 'DevToolsActivePort'), { force: true }); } catch {}
    try { rmSync(this.pageFile, { force: true }); } catch {}
  }

  /* -------------------------------------------------------------- CDP wire */

  send(method, params = {}, sessionId = undefined) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('browser not connected'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
    });
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id !== undefined) {
      const handler = this.pending.get(message.id);
      if (handler) { this.pending.delete(message.id); handler(message); }
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers) for (const handler of handlers) handler(message.params, message.sessionId);
  }

  on(method, handler) {
    let set = this.listeners.get(method);
    if (!set) { set = new Set(); this.listeners.set(method, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  /* ---------------------------------------------------------------- events */

  bindPageEvents() {
    this.on('Page.frameNavigated', (params) => {
      if (params.frame?.parentId) return;
      const url = String(params.frame?.url || '');
      // A failed navigation shows an internal error document; keep the address the user
      // asked for so the address bar still tells them what broke.
      if (!url || /^(chrome-error|chrome-untrusted|chrome):/i.test(url)) {
        this.state.loading = true;
        return;
      }
      this.state.url = url;
      this.state.loading = true;
      this.#broadcast({ type: 'state', state: this.state });
      this.#refreshMeta();
    });
    this.on('Page.loadEventFired', () => {
      this.state.loading = false;
      this.#refreshMeta();
      this.#broadcast({ type: 'state', state: this.state });
      this.#rememberPage();
      // A navigation can end the screencast while the flag still says it is on.
      this.#ensureScreencast().catch(() => {});
    });
    this.on('Page.screencastFrame', async (params) => {
      const meta = params.metadata || {};
      const view = this.state.viewport;
      // Frames produced for the previous viewport can arrive after a resize; showing
      // them leaves the panel letterboxed at the old shape until the next paint.
      const stale = typeof meta.deviceWidth === 'number' && typeof meta.deviceHeight === 'number'
        && (Math.round(meta.deviceWidth) !== view.width || Math.round(meta.deviceHeight) !== view.height);
      if (!stale) {
        this.lastFrame = params.data;
        this.frameCount += 1;
        this.#broadcast({ type: 'frame', data: params.data });
      }
      try { await this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, this.sessionId); } catch {}
    });
    this.on('Inspector.targetCrashed', () => {
      this.state.error = 'page crashed';
      this.#broadcast({ type: 'state', state: this.state });
    });
  }

  async #refreshMeta() {
    try {
      const result = await this.send('Runtime.evaluate',
        { expression: 'document.title', returnByValue: true }, this.sessionId);
      this.state.title = result?.result?.value ?? '';
    } catch {}
    this.#broadcast({ type: 'state', state: this.state });
  }

  #broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...this.clients]) {
      try { client.write(payload); } catch { this.clients.delete(client); }
    }
  }

  addClient(res) {
    this.clients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
      if (this.clients.size === 0) this.#stopScreencast();
    });
    res.write(`data: ${JSON.stringify({ type: 'state', state: this.state })}\n\n`);
    if (this.lastFrame) res.write(`data: ${JSON.stringify({ type: 'frame', data: this.lastFrame })}\n\n`);
    this.#startScreencast().catch(() => {});
  }

  reveal() {
    this.lastRevealAt = Date.now();
    this.#broadcast({ type: 'reveal' });
  }

  noteVisibility(id, visible) {
    const key = String(id || 'default').slice(0, 80);
    if (key === 'module') {
      // A connected client that knows this protocol: no legacy fallback from now on.
      this.visibilityAware = true;
    } else if (visible) {
      this.touch();
      this.visibleSurfaces.set(key, Date.now());
    } else {
      this.visibleSurfaces.delete(key);
    }
    if (key !== 'module') {
      // Forget surfaces that stopped heartbeating (crashed tab, closed window).
      const cutoff = Date.now() - 45000;
      for (const [surfaceId, at] of this.visibleSurfaces) {
        if (at < cutoff) this.visibleSurfaces.delete(surfaceId);
      }
    }
    if (this.#anyVisible()) this.#ensureScreencast().catch(() => {});
    else this.#stopScreencast();
  }

  #anyVisible() {
    if (this.visibilityAware) return this.visibleSurfaces.size > 0;
    return this.clients.size > 0; // legacy client without visibility reporting
  }

  /* ------------------------------------------------------------- screencast */

  async #startScreencast() {
    if (this.screencastOn || !this.sessionId || !this.#anyVisible()) return;
    this.screencastOn = true;
    this.screencastAttempts = (this.screencastAttempts || 0) + 1;
    const { width, height } = this.state.viewport;
    // Frames are expensive: a JPEG screencast at 60fps keeps a whole core busy and
    // churns memory through React, so cap the rate and the payload size.
    const maxWidth = Math.min(width, 1000);
    const maxHeight = Math.round((maxWidth / Math.max(1, width)) * height);
    try {
      await this.send('Page.startScreencast', {
        format: 'jpeg', quality: 50, maxWidth, maxHeight, everyNthFrame: 3,
      }, this.sessionId);
      this.lastScreencastError = null;
    } catch (error) {
      this.screencastOn = false;
      this.lastScreencastError = String(error && error.message ? error.message : error);
    }
  }

  #stopScreencast() {
    if (!this.screencastOn || !this.sessionId) return;
    this.screencastOn = false;
    this.send('Page.stopScreencast', {}, this.sessionId).catch(() => {});
  }

  async #ensureScreencast() {
    if (!this.sessionId || this.clients.size === 0 || !this.#anyVisible()) {
      this.#stopScreencast();
      return;
    }
    // Heartbeats re-state visibility; keep the running screencast instead of stopping
    // and restarting it on every report.
    if (this.screencastOn) return;
    await this.#startScreencast();
  }

  async #restartScreencast() {
    if (this.screencastOn) {
      await this.#stopScreencastAsync();
      this.screencastOn = false;
    }
    await this.#startScreencast();
  }

  // Adopted browsers have no child pid, so a stale Edge keeps running unless it is
  // found by the profile path it was launched with.
  #killProfileProcesses() {
    try {
      const pattern = "'*" + this.dataDir + "*'";
      const script = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '
        + "'msedge.exe' -and $_.CommandLine -like " + pattern + ' }'
        + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: 'ignore', timeout: 8000,
      });
    } catch {}
  }

  /* ------------------------------------------------------------------ state */

  async setViewport(width, height) {
    const w = Math.max(320, Math.min(3840, Math.round(width)));
    const h = Math.max(240, Math.min(2400, Math.round(height)));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return this.state;
    if (this.state.viewport.width === w && this.state.viewport.height === h && this.sessionId) return this.state;
    this.state.viewport = { width: w, height: h };
    if (!this.sessionId) return this.state;
    await this.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false }, this.sessionId);
    this.#broadcast({ type: 'state', state: this.state });
    await this.#restartScreencast();
    await this.captureFrame();
    return this.state;
  }

  async #stopScreencastAsync() {
    try { await this.send('Page.stopScreencast', {}, this.sessionId); } catch {}
  }

  /* ------------------------------------------------------------- operations */

  async navigate(url) {
    await this.ensure();
    const target = /^(https?:|about:|data:|file:)/i.test(url) ? url : `https://${url}`;
    this.state.error = null;
    this.state.url = target;
    this.state.loading = true;
    this.#broadcast({ type: 'state', state: this.state });
    const result = await this.send('Page.navigate', { url: target }, this.sessionId);
    if (result && result.errorText) {
      this.state.loading = false;
      this.state.error = `打不开 ${target}：${result.errorText}`;
      this.#broadcast({ type: 'state', state: this.state });
      await this.captureFrame();
      this.reveal();
      return { ...this.state };
    }
    await this.#waitForLoad(15000);
    await this.captureFrame();
    this.reveal();
    return { ...this.state };
  }

  async captureFrame() {
    if (!this.sessionId) return;
    try {
      const { data } = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, this.sessionId);
      this.lastFrame = data;
      this.frameCount += 1;
      this.#broadcast({ type: 'frame', data });
    } catch {}
  }

  async #waitForLoad(timeout = 15000) {
    const deadline = Date.now() + timeout;
    let checkedAt = 0;
    while (Date.now() < deadline) {
      if (!this.state.loading) return true;
      // Same-document navigations (hash links, history rewrites) never fire a load
      // event, so a ready document ends the wait instead of burning the whole timeout.
      if (Date.now() - checkedAt > 400) {
        checkedAt = Date.now();
        try {
          const result = await this.send('Runtime.evaluate',
            { expression: 'document.readyState', returnByValue: true }, this.sessionId);
          if (result?.result?.value === 'complete') {
            this.state.loading = false;
            return true;
          }
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.state.loading = false;
    return false;
  }

  async evaluate(expression) {
    await this.ensure();
    const result = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'page evaluation failed');
    }
    return result.result?.value;
  }

  async snapshot() {
    const script = `(() => { ${ENUM_FN}
      const els = kattList();
      return els.map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          ref: i + 1,
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          label: kattLabel(el),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        };
      });
    })()`;
    const elements = await this.evaluate(script);
    const text = await this.evaluate('document.body ? document.body.innerText.slice(0, 4000) : ""');
    return { url: this.state.url, title: this.state.title, elements, text };
  }

  async #elementRect(ref) {
    const script = `(() => { ${ENUM_FN}
      const el = kattList()[${Number(ref) - 1}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`;
    const box = await this.evaluate(script);
    if (!box) throw new Error(`ref e${ref} 不存在，请重新 snapshot`);
    return box;
  }

  async clickRef(ref, clickCount = 1) {
    const { x, y } = await this.#elementRect(ref);
    await this.#mouse('mousePressed', x, y, clickCount);
    await this.#mouse('mouseReleased', x, y, clickCount);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ok: true, ref: Number(ref), x, y };
  }

  async typeRef(ref, text, clear = false, submit = false) {
    const box = await this.#elementRect(ref);
    await this.#mouse('mousePressed', box.x, box.y, 1);
    await this.#mouse('mouseReleased', box.x, box.y, 1);
    if (clear) {
      await this.send('Runtime.evaluate', {
        expression: `(() => { const el = document.activeElement; if (!el) return; if ('value' in el) el.value = ''; else if (el.isContentEditable) el.textContent = ''; })()`,
      }, this.sessionId);
    }
    await this.send('Input.insertText', { text }, this.sessionId);
    if (submit) await this.pressKey('Enter');
    return { ok: true, ref: Number(ref), typed: text.length };
  }

  async pressKey(name) {
    const spec = KEY_CODES[name];
    if (!spec) {
      if (name.length === 1) {
        await this.send('Input.insertText', { text: name }, this.sessionId);
        return { ok: true, inserted: name };
      }
      throw new Error(`不支持的按键: ${name}`);
    }
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId);
    if (spec.text) await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: spec.text }, this.sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
    return { ok: true, key: name };
  }

  async scroll(deltaY) {
    const { width, height } = this.state.viewport;
    await this.#wheel(width / 2, height / 2, 0, deltaY);
    return { ok: true, deltaY };
  }

  // Chromium's raw wheel dispatch can stall indefinitely on a flat session while the
  // page is idle; the synthesized gesture is the reliable way to scroll a headless page.
  async #wheel(x, y, deltaX = 0, deltaY = 0) {
    const attempt = (method, params, ms = 4000) => Promise.race([
      this.send(method, params, this.sessionId),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timeout`)), ms)),
    ]);
    const scrollBefore = await this.evaluate('window.scrollY').catch(() => null);
    try {
      await attempt('Input.synthesizeScrollGesture', {
        x: Math.round(x),
        y: Math.round(y),
        xDistance: Math.round(-deltaX),
        yDistance: Math.round(-deltaY),
        speed: 800,
        gestureSourceType: 'mouse',
      });
    } catch {
      try {
        await attempt('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, pointerType: 'mouse' });
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 160));
    const scrollAfter = await this.evaluate('window.scrollY').catch(() => null);
    // A synthesized gesture can be accepted but swallowed (background tab, first wheel
    // after an attach); a scripted scroll is the dependable fallback.
    if (typeof scrollBefore === 'number' && typeof scrollAfter === 'number' && scrollAfter === scrollBefore && deltaY !== 0) {
      await this.evaluate(`window.scrollBy(0, ${Math.round(deltaY)})`).catch(() => {});
    }
  }

  async back() { await this.evaluate('history.back(), 1'); await this.#waitForLoad(10000); return { ...this.state }; }
  async forward() { await this.evaluate('history.forward(), 1'); await this.#waitForLoad(10000); return { ...this.state }; }
  async reload() { await this.send('Page.reload', {}, this.sessionId); await this.#waitForLoad(15000); return { ...this.state }; }

  async screenshot(name = 'shot') {
    await this.ensure();
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${name}-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return { file, bytes: Math.round((data.length * 3) / 4) };
  }

  /* ---------------------------------------------------------------- input */

  async #mouse(type, x, y, clickCount = 0, button = 'left', buttonsMask = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button, buttons: buttonsMask, clickCount,
    }, this.sessionId);
  }

  async handleInput(event) {
    this.touch();
    await this.ensure();
    const kind = event?.kind;
    if (kind === 'mouse') {
      const rawX = Number(event.x);
      const rawY = Number(event.y);
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return { ok: false };
      // Keep every dispatch inside the emulated viewport: out-of-range coordinates can
      // wedge Chromium's input queue, which then hangs every later input command.
      const x = Math.max(0, Math.min(this.state.viewport.width - 1, rawX));
      const y = Math.max(0, Math.min(this.state.viewport.height - 1, rawY));
      const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
      const mask = event.buttons ?? 0;
      if (event.action === 'move') await this.#mouse('mouseMoved', x, y, 0, mask ? button : 'none', mask);
      else if (event.action === 'down') await this.#mouse('mousePressed', x, y, 1, button, mask || 1);
      else if (event.action === 'up') await this.#mouse('mouseReleased', x, y, 1, button, 0);
      else if (event.action === 'wheel') {
        await this.#wheel(x, y, event.deltaX ?? 0, event.deltaY ?? 0);
      }
      return { ok: true };
    }
    if (kind === 'text') {
      await this.send('Input.insertText', { text: String(event.text ?? '') }, this.sessionId);
      return { ok: true };
    }
    if (kind === 'combo') {
      const letter = String(event.key || 'a').toLowerCase().slice(0, 1);
      let modifiers = 0;
      if (event.alt) modifiers |= 1;
      if (event.ctrl) modifiers |= 2;
      if (event.meta) modifiers |= 4;
      if (event.shift) modifiers |= 8;
      const vk = letter.toUpperCase().charCodeAt(0);
      const base = { key: letter, code: `Key${letter.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
      return { ok: true };
    }
    if (kind === 'key') {
      return this.pressKey(String(event.key ?? ''));
    }
    return { ok: false };
  }
}

/* ---------------------------------------------------------------- tool defs */

function buildTools(browser) {
  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  const output = { schema: { type: 'object' }, render: (_args, value) => text(value) };
  const schema = (properties, required = []) => ({
    type: 'object', properties, required, additionalProperties: false,
  });
  return [
    {
      name: 'browser_open',
      description: '在共享浏览器里打开一个网址（用户侧边面板会同步显示并可以继续手动操作）。不传 url 时打开默认首页（默认 Bing，配置项 homeUrl）。',
      parameters: schema({
        url: { type: 'string', description: '要打开的网址；留空则打开默认首页（Bing）' },
        waitFor: { type: 'string', description: '等这个 CSS 选择器出现再返回（SPA 水合用，最多等 15 秒）' },
        waitMs: { type: 'number', description: '打开后额外等待的毫秒数（最多 30 秒）' },
      }),
      output,
      execute: async (args) => {
        const wanted = args && args.url ? String(args.url).trim() : '';
        const state = await browser.navigate(wanted, { waitFor: args && args.waitFor, waitMs: args && args.waitMs });
        return { ...state, barriers: await browser.barriers?.().catch(() => null) };
      },
    },
    {
      name: 'browser_snapshot',
      description: '读取页面结构：可交互元素清单（带 eN 引用）+ 文本。优先用它和 browser_evaluate 拿页面信息，不要先截图。detail=compact 省 token，只给交互元素和少量文本；div 拼的页面没有 ARIA 角色时会自动补 DOM 可点击候选，实在没有结构就返回正文文本并附 note。full（默认）含文本节点，最稳。',
      parameters: schema({
        detail: { type: 'string', enum: ['compact', 'full'], description: 'compact 只给交互元素；full 含文本节点（默认）' },
      }),
      output,
      execute: async (args) => browser.snapshot(args && args.detail ? args.detail : 'full'),
    },
    {
      name: 'browser_history',
      description: '查看本插件最近的操作记录（导航/点击/输入/标签/上传/Cookie 快照），排查问题时用。action=read 默认，clear 清空。',
      parameters: schema({
        action: { type: 'string', enum: ['read', 'clear'], description: '默认 read' },
        limit: { type: 'number', description: '最多返回多少条，默认 50' },
      }),
      output,
      execute: async (args) => {
        if (args && args.action === 'clear' && typeof browser.clearHistory === 'function') return browser.clearHistory();
        return typeof browser.actionHistory === 'function' ? browser.actionHistory(args && args.limit ? args.limit : 50) : { error: '当前驱动不支持操作记录' };
      },
    },
    {
      name: 'browser_click',
      description: '点击页面元素。优先用快照里的 eN 引用（ref，真实鼠标事件）；也可以给 selector 或 text（可见文字）让工具自己定位。删除/支付/注销这类危险按钮走 ref + confirm=true。',
      parameters: schema({
        ref: { type: 'integer', minimum: 1, description: 'snapshot 返回的 ref（与 selector/text 三选一）' },
        selector: { type: 'string', description: 'CSS 选择器，例如 button[type=submit]' },
        text: { type: 'string', description: '按可见文字定位，例如「登录」' },
        confirm: { type: 'boolean', description: '危险操作（删除/支付等）需要显式确认' },
      }),
      output,
      execute: async (args) => {
        const selector = args && args.selector ? String(args.selector) : '';
        const text = args && args.text ? String(args.text) : '';
        if (selector !== '' || text !== '') return browser.clickLocated({ selector, text });
        if (!args || args.ref === undefined) return { error: '需要 ref、selector 或 text 之一' };
        return browser.clickRef(Number(args.ref), Boolean(args.confirm));
      },
    },
    {
      name: 'browser_wait',
      description: '等页面达到某个状态：选择器出现、正文包含某段文字、URL 前缀匹配，任一满足就返回；超时返回 timedOut 和最后一次没命中的原因。比反复 evaluate 轮询省事。',
      parameters: schema({
        selector: { type: 'string', description: 'CSS 选择器，元素出现且可见' },
        text: { type: 'string', description: '页面正文里应包含的文字' },
        url: { type: 'string', description: 'URL 前缀（不含 # 之后的片段）' },
        timeoutMs: { type: 'number', description: '最长等待毫秒，默认 8000，上限 60000' },
      }),
      output,
      execute: async (args) => browser.waitFor({
        selector: args && args.selector,
        text: args && args.text,
        url: args && args.url,
        timeoutMs: args && args.timeoutMs,
      }),
    },
    {
      name: 'browser_type',
      description: '在快照里的 eN 输入框里输入文字，可选清空和回车提交。',
      parameters: schema({
        ref: { type: 'integer', minimum: 1 },
        text: { type: 'string' },
        clear: { type: 'boolean', description: '先清空原内容' },
        submit: { type: 'boolean', description: '输入后按回车' },
      }, ['ref', 'text']),
      output,
      execute: async (args) => browser.typeRef(Number(args.ref), String(args.text), Boolean(args.clear), Boolean(args.submit)),
    },
    {
      name: 'browser_press_key',
      description: '发送一个按键，例如 Enter、Tab、Escape、Backspace、ArrowDown、PageDown、Space。',
      parameters: schema({ key: { type: 'string' } }, ['key']),
      output,
      execute: async (args) => browser.pressKey(String(args.key)),
    },
    {
      name: 'browser_zoom',
      description: '放大或缩小当前页面（相当于浏览器的 Ctrl+= / Ctrl+-）。direction: in 放大、out 缩小、reset 回到 100%、set 指定倍数；倍数范围 0.25~5。',
      parameters: schema({
        direction: { type: 'string', enum: ['in', 'out', 'reset', 'set'], description: '缩放方向，默认 in' },
        factor: { type: 'number', description: 'set 时的缩放倍数，例如 1.25、0.8' },
      }),
      output,
      execute: async (args) => browser.zoom(String((args && args.direction) || 'in'), Number(args && args.factor)),
    },
    {
      name: 'browser_scroll',
      description: '在页面中滚动，正数向下、负数向上（单位：像素）。',
      parameters: schema({ deltaY: { type: 'number' } }, ['deltaY']),
      output,
      execute: async (args) => browser.scroll(Number(args.deltaY)),
    },
    {
      name: 'browser_state',
      description: '查看共享浏览器的当前网址、标题、加载状态和面板尺寸。',
      parameters: schema({}),
      output,
      execute: async () => ({
        ...browser.state,
        zoom: browser.diagnostics?.zoomFactor ?? undefined,
        ...(browser.probe ? { panel: browser.probe } : {}),
        barriers: await browser.barriers?.().catch(() => null),
      }),
    },
    {
      name: 'browser_page_diag',
      description: '检查 DSH 页面自身的渲染开销（每秒动画帧数、还在跑的 CSS 动画、DOM 节点数），用于排查界面卡顿。mode 可选 pause/resume 用来做对照实验。',
      parameters: schema({ mode: { type: 'string', enum: ['report', 'pause', 'resume', 'raf'], description: 'report 只看，pause/resume 暂停或恢复 CSS 动画，raf 抓取每秒请求动画帧的调用来源' } }),
      output,
      execute: async (args) => browser.pageDiagnostics(String((args && args.mode) || 'report')),
    },
    {
      name: 'browser_probe',
      description: '检查右侧栏浏览器面板的原生 webview 是否就绪，以及它支持哪些能力。',
      parameters: schema({}),
      output,
      execute: async () => {
        await browser.refreshProbe().catch(() => null);
        return {
          driver: browser.diagnostics || null,
          panel: browser.probe
            ? { ...browser.probe, state: browser.state }
            : { hasWebview: false, hint: '右侧栏还没有打开“浏览器”标签页，或页面需要刷新加载新版客户端' },
        };
      },
    },
    {
      name: 'browser_serve',
      description: '起/停本地 HTTP 静态服务。侧栏 webview 打不开 file://，本地页面用这个映射成 http://127.0.0.1:<port>/ 再打开。',
      parameters: schema({
        action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'start 起服务、stop 停某个端口、list 看正在跑的' },
        directory: { type: 'string', description: '要暴露的目录（start 用，默认当前工作目录）' },
        port: { type: 'number', description: '端口（start 默认 7810；stop 时必填）' },
      }, ['action']),
      output,
      execute: async (args) => {
        const action = String((args && args.action) || 'list');
        if (action === 'start') return startServe(args && args.directory ? args.directory : '.', args && args.port ? args.port : 7810);
        if (action === 'stop') {
          if (!args || !args.port) return { error: 'stop 需要 port' };
          return stopServe(args.port);
        }
        return listServe();
      },
    },
    {
      name: 'browser_open_file',
      description: '打开本机/工作区里的文件：自动为该文件所在目录起 http://127.0.0.1 静态服务，并让侧栏浏览器打开它。看本地 html、或者让 agent 点本地页面的控件时，比 browser_serve + browser_open 少两步。',
      parameters: schema({
        path: { type: 'string', description: '文件或目录的绝对路径（相对路径按 host 进程的当前目录解析）' },
      }, ['path']),
      output,
      execute: async (args) => openLocalFile(args && args.path, browser),
    },
    {
      name: 'browser_download',
      description: '下载文件。侧栏浏览器本身禁用了下载，这里在页面里用 fetch（带登录态）取字节，再由宿主写到磁盘，默认存到 用户目录/Downloads/katt-browser。',
      parameters: schema({
        url: { type: 'string', description: '要下载的地址（绝对 URL 或同源相对路径）' },
        filename: { type: 'string', description: '保存的文件名，不填则用响应头或 URL 末段' },
        saveDir: { type: 'string', description: '保存目录，不填则用 Downloads/katt-browser' },
      }, ['url']),
      output,
      execute: async (args) => browser.download(args && args.url, args && args.filename, args && args.saveDir),
    },
    {
      name: 'browser_cookies',
      description: '浏览器的 Cookie 和缓存管理。action=list 查看；save/load 按 name 保存或还原 Cookie 快照（可实现多账号切换）；clear 清空全部 Cookie；clear-site 清当前站点数据；clear-cache 清缓存；profiles 列出已保存的快照。',
      parameters: schema({
        action: { type: 'string', enum: ['list', 'save', 'load', 'clear', 'clear-site', 'clear-cache', 'profiles'], description: '要执行的操作' },
        name: { type: 'string', description: 'Cookie 快照名称（save/load 时使用，默认 default）' },
      }, ['action']),
      output,
      execute: async (args) => {
        const action = String((args && args.action) || 'list');
        if (action === 'profiles') return browser.profiles();
        return browser.cookiesAction(action, args && args.name);
      },
    },
    {
      name: 'browser_instrument',
      description: '读取页面的 worker 消息和存储写入（canvas/worker 渲染的游戏，状态通常在这里，不需要截图）。',
      parameters: schema({}),
      output,
      execute: async () => browser.instrumentData(),
    },
    {
      name: 'browser_tabs',
      description: '管理右侧栏的浏览器标签页。action=list 列出（closeExtras=true 顺手清理死标签）；switch 切换到 tabId 并绑定 CDP 目标；new 新建标签页并打开 url；close 关闭指定 tabId。',
      parameters: schema({
        action: { type: 'string', enum: ['list', 'switch', 'new', 'close'], description: '要执行的操作，默认 list' },
        tabId: { type: 'string', description: 'switch/close 时必填，来自 list 结果' },
        url: { type: 'string', description: 'new 时要打开的网址' },
        closeExtras: { type: 'boolean', description: 'list 时顺手清理没有页面的多余标签' },
      }),
      output,
      execute: async (args) => {
        const action = String((args && args.action) || 'list');
        if (action === 'switch') {
          if (!args || !args.tabId) return { error: 'switch 需要 tabId' };
          return browser.tabSwitch(args.tabId);
        }
        if (action === 'new') {
          if (!args || !args.url) return { error: 'new 需要 url' };
          return browser.tabNew(args.url);
        }
        if (action === 'close') {
          if (!args || !args.tabId) return { error: 'close 需要 tabId' };
          return browser.tabClose(args.tabId);
        }
        return browser.listTabs(Boolean(args && args.closeExtras));
      },
    },
    {
      name: 'browser_hover',
      description: '把鼠标移到坐标 (x,y) 上（布局坐标，视口左上角为原点），用于展开悬停菜单。',
      parameters: schema({
        x: { type: 'number', description: '横坐标' },
        y: { type: 'number', description: '纵坐标' },
      }, ['x', 'y']),
      output,
      execute: async (args) => browser.hoverAt(args.x, args.y),
    },
    {
      name: 'browser_upload',
      description: '上传文件到页面的文件输入框（传本机文件路径，可多个）。',
      parameters: schema({
        selector: { type: 'string', description: '文件输入框的 CSS 选择器' },
        files: { description: '文件路径，字符串或字符串数组', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      }, ['selector', 'files']),
      output,
      execute: async (args) => browser.setFiles(args.selector, args.files),
    },
    {
      name: 'browser_text',
      description: '把当前页面内容提取成可读文本（去掉导航/页脚/脚本），返回标题、链接列表。format=markdown 时保留标题层级、链接、列表、表格和代码块，更适合整理资料。',
      parameters: schema({
        maxChars: { type: 'number', description: '正文最多保留多少字符，默认 4000（markdown 默认 6000）' },
        format: { type: 'string', enum: ['text', 'markdown'], description: 'text=纯文本（默认），markdown=结构化文本' },
      }),
      output,
      execute: async (args) => {
        const markdown = Boolean(args && args.format === 'markdown');
        const limit = args && args.maxChars ? args.maxChars : (markdown ? 6000 : 4000);
        return markdown ? browser.pageMarkdown(limit) : browser.pageText(limit);
      },
    },
    {
      name: 'browser_table',
      description: '把页面里的表格导出成表头 + 行数据（最多 3 个表、每个 30 行），爬取结构化数据用。',
      parameters: schema({
        maxTables: { type: 'number', description: '最多导出几个表，默认 3' },
        maxRows: { type: 'number', description: '每个表最多多少行，默认 30' },
      }),
      output,
      execute: async (args) => browser.pageTables(args && args.maxTables ? args.maxTables : 3, args && args.maxRows ? args.maxRows : 30),
    },
    {
      name: 'browser_console',
      description: '读取页面 console 日志和未捕获异常（调试白屏/脚本错误用）。action=read 默认，clear 清空；level 可按 log/warn/error 过滤。',
      parameters: schema({
        action: { type: 'string', enum: ['read', 'clear'], description: '默认 read' },
        level: { type: 'string', description: 'user 可选：按日志级别过滤，如 error、warning' },
        limit: { type: 'number', description: '最多返回多少条，默认 50' },
      }),
      output,
      execute: async (args) => {
        if (args && args.action === 'clear') return browser.clearDiagnostics('console');
        return browser.consoleLogs(args && args.limit ? args.limit : 50, args && args.level);
      },
    },
    {
      name: 'browser_network',
      description: '读取页面网络请求历史（方法/URL/状态码/类型/耗时），可按 URL 子串过滤，action=clear 清空。排查接口、登录态、失败请求用。',
      parameters: schema({
        action: { type: 'string', enum: ['read', 'clear'], description: '默认 read' },
        filter: { type: 'string', description: 'URL 子串过滤' },
        limit: { type: 'number', description: '最多返回多少条，默认 50' },
      }),
      output,
      execute: async (args) => {
        if (args && args.action === 'clear') return browser.clearDiagnostics('network');
        return browser.networkLogs(args && args.limit ? args.limit : 50, args && args.filter);
      },
    },
    {
      name: 'browser_back',
      description: '浏览器后退。',
      parameters: schema({}),
      output,
      execute: async () => browser.back(),
    },
    {
      name: 'browser_forward',
      description: '浏览器前进。',
      parameters: schema({}),
      output,
      execute: async () => browser.forward(),
    },
    {
      name: 'browser_reload',
      description: '重新加载当前页面。',
      parameters: schema({}),
      output,
      execute: async () => browser.reload(),
    },
    {
      name: 'browser_screenshot',
      description: '对当前视口截图并保存为 PNG。最后手段：页面信息优先用 browser_snapshot / browser_text / browser_evaluate 拿结构，只有结构表达不了视觉（canvas、图片、排版样式）或结构通道失效时才截图，截图读不出时长、数量这类数据。',
      parameters: schema({}),
      output,
      execute: async () => browser.screenshot('agent'),
    },
    {
      name: 'browser_evaluate',
      description: '在页面里执行一段 JavaScript 并返回结果（逃生舱，优先用 snapshot/click/type）。',
      parameters: schema({ code: { type: 'string', description: '要在页面上下文执行的 JS 表达式' } }, ['code']),
      output,
      execute: async (args) => ({ result: await browser.evaluate(String(args.code)) }),
    },
    {
      name: 'browser_close',
      description: '关闭右侧栏里的浏览器标签页，释放该页面占用的内存。',
      parameters: schema({}),
      output,
      execute: async () => {
        await browser.hardClose();
        return { ok: true };
      },
    },
  ];
}

/* ---------------------------------------------------------------------- plugin */

export const inject = ['tools', 'webServer'];
export const name = 'katt-browser';

export function apply(ctx, config = {}) {
  const driver = config.driver === 'headless' ? 'headless' : 'webview';
  const headless = driver === 'headless' ? new BrowserSession(config) : null;
  const pageWebview = driver === 'webview' ? new WebviewSession(config) : null;
  const webview = pageWebview ? new HybridSession(config, pageWebview) : null;
  const bridge = pageWebview ? pageWebview.bridge : null;
  const browser = headless || webview;

  const diagnostics = () => {
    if (headless) {
      return {
        driver,
        clients: headless.clients.size,
        frames: headless.frameCount,
        hello: headless.hello,
        screencast: headless.screencastOn,
        visible: headless.visibleSurfaces.size,
        revealAt: headless.lastRevealAt,
        uptimeMs: headless.startedAt ? Date.now() - headless.startedAt : 0,
      };
    }
    return {
      driver,
      mode: webview.driver,
      cdpPort: config.cdpPort || null,
      connected: bridge.connected,
      version: bridge.version,
      queued: bridge.queue.length,
      hello: bridge.hello,
      probe: bridge.probe,
      lastPullAt: bridge.client.lastPullAt,
    };
  };

  const handlers = {
    [ROUTE_CONFIG]: (req, res) => {
      if (preflight(req, res)) return;
      sendJson(res, 200, { driver, version: '0.7.0' }, CORS_HEADERS);
    },
    [ROUTE_STATE]: (req, res) => {
      if (preflight(req, res)) return;
      sendJson(res, 200, { state: browser.state, frame: null, diagnostics: diagnostics() }, CORS_HEADERS);
    },
    [ROUTE_HELLO]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const hello = { at: Date.now(), ...body };
        if (headless) headless.hello = hello;
        else bridge.noteHello(body);
        sendJson(res, 200, { ok: true }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_STREAM]: (req, res) => {
      if (preflight(req, res)) return;
      if (!headless) {
        // Webview driver pulls commands over HTTP; keep the route but say so.
        sendJson(res, 410, { error: 'webview 驱动使用 /pull 轮询，不再推流' }, CORS_HEADERS);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...CORS_HEADERS,
      });
      headless.ensure().catch(() => {});
      headless.addClient(res);
    },
    [ROUTE_PULL]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        if (!bridge) {
          sendJson(res, 200, { commands: [] }, CORS_HEADERS);
          return;
        }
        if (!bridge.accepts(body.v)) {
          sendJson(res, 200, { commands: [], stale: true }, CORS_HEADERS);
          return;
        }
        const commands = await bridge.takeCommands(String(body.v || ''), 15000);
        sendJson(res, 200, { commands }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_ACTION]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const op = String(body.op || '');
        if (op === 'open') { sendJson(res, 200, await browser.navigate(String(body.url || '')), CORS_HEADERS); return; }
        if (op === 'back') { sendJson(res, 200, await browser.back(), CORS_HEADERS); return; }
        if (op === 'forward') { sendJson(res, 200, await browser.forward(), CORS_HEADERS); return; }
        if (op === 'reload') { sendJson(res, 200, await browser.reload(), CORS_HEADERS); return; }
        if (op === 'viewport') {
          sendJson(res, 200, await browser.setViewport(Number(body.width), Number(body.height)), CORS_HEADERS);
          return;
        }
        if (op === 'ensure') { await browser.ensure(); sendJson(res, 200, { state: browser.state }, CORS_HEADERS); return; }
        if (op === 'dispose') {
          if (headless) headless.dispose();
          sendJson(res, 200, { ok: true }, CORS_HEADERS);
          return;
        }
        sendJson(res, 400, { error: `unknown op ${op}` }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_VISIBILITY]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        if (headless) headless.noteVisibility(body.id, body.visible !== false);
        sendJson(res, 200, { ok: true }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_FRAME]: async (req, res) => {
      if (preflight(req, res)) return;
      if (!headless) {
        sendJson(res, 200, { data: null, state: browser.state, error: 'webview 驱动没有帧缓存' }, CORS_HEADERS);
        return;
      }
      try {
        await headless.ensure();
        const url = String(req.url || '');
        if (url.includes('fresh=1') || !headless.lastFrame) await headless.captureFrame();
        sendJson(res, 200, { data: headless.lastFrame, state: headless.state }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_INPUT]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        if (headless) {
          sendJson(res, 200, await headless.handleInput(body), CORS_HEADERS);
        } else {
          sendJson(res, 200, { ok: false, error: '原生面板自己处理输入，不需要转发' }, CORS_HEADERS);
        }
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_RESULT]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        if (bridge) bridge.handleResult(body);
        sendJson(res, 200, { ok: true }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_PAGE_STATE]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        if (bridge && bridge.accepts(body.v)) bridge.setPageState(body);
        sendJson(res, 200, { ok: true }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_PROBE]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        if (bridge && bridge.accepts(body.v)) bridge.setProbe(body);
        sendJson(res, 200, { ok: true }, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
    [ROUTE_OPEN_FILE]: async (req, res) => {
      if (preflight(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const result = await openLocalFile(body && body.path, browser);
        sendJson(res, result && result.error ? 400 : 200, result, CORS_HEADERS);
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message || error) }, CORS_HEADERS);
      }
    },
  };

  ctx.effect(() => {
    const disposers = [];
    for (const tool of buildTools(browser)) {
      disposers.push(ctx.tools.register(tool));
    }
    for (const [routePath, handler] of Object.entries(handlers)) {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: routePath, handler }));
    }
    // Hand the page its absolute origin so the client can reach these routes even
    // when the desktop shell serves the app from the dsh-app:// scheme.
    disposers.push(ctx.on('webserver/index-inject', (table) => {
      try {
        table.push({ kind: 'global', name: '__KATT_BROWSER_ORIGIN__', value: ctx.webServer.getOrigin() });
      } catch {}
    }));
    return () => {
      for (const dispose of disposers) { try { dispose(); } catch {} }
      try { stopAllServe(); } catch {}
      browser.dispose();
    };
  });
}
