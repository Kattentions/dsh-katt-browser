/**
 * katt-browser — webview driver.
 *
 * The panel is the shipped right-sidebar Browser tab, i.e. a native Electron
 * <webview> guest. Nothing is streamed: the client half forwards commands to the
 * guest element and reports its state. Cheap in CPU and memory compared with the
 * former headless-Chromium + JPEG screencast driver.
 *
 * Transport is HTTP polling on purpose: a plugin reload used to leave the page's
 * EventSource stuck in CONNECTING, which silently stopped command delivery.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHOT_DIR = path.join(os.tmpdir(), 'katt-browser-shots');
const CLIENT_TTL_MS = 20000;

class PendingCommand {
  constructor(timeoutMs, op, onTimeout) {
    this.op = op;
    this.timer = setTimeout(() => onTimeout(new Error(`浏览器命令超时：${op}`)), timeoutMs);
  }

  settle() {
    clearTimeout(this.timer);
  }
}

function versionScore(version) {
  const parts = String(version || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  return (parts[0] || 0) * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0);
}

export class WebviewBridge {
  constructor(config = {}) {
    this.config = config;
    this.pending = new Map();
    this.nextId = 1;
    this.queue = [];
    this.waiters = [];
    this.client = { version: '', lastPullAt: 0, lastHelloAt: 0, hello: null };
    this.probe = null;
    this.state = {
      url: 'about:blank',
      title: '',
      loading: false,
      ready: false,
      error: null,
      viewport: { width: 0, height: 0 },
    };
  }

  get hello() {
    return this.client.hello;
  }

  get lastRevealAt() {
    return this.client.lastHelloAt;
  }

  get connected() {
    return Date.now() - Math.max(this.client.lastPullAt, this.client.lastHelloAt) < CLIENT_TTL_MS;
  }

  get version() {
    return this.client.version;
  }

  noteHello(body) {
    const hello = { at: Date.now(), ...body };
    this.client.hello = hello;
    this.client.lastHelloAt = hello.at;
    if (body && body.version) this.client.version = String(body.version);
  }

  // Reports from stale client copies must not overwrite the current panel state.
  accepts(version) {
    if (!version) return true;
    return versionScore(version) >= versionScore(this.client.version || '0');
  }

  async waitForClient(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!this.connected) throw new Error('浏览器面板未连接：请先在右侧栏打开“浏览器”标签页');
  }

  #deliver(command) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve([command]);
    else this.queue.push(command);
  }

  // Long-poll: resolve as soon as a command exists, otherwise after the timeout.
  takeCommands(version, timeoutMs = 15000) {
    this.client.lastPullAt = Date.now();
    if (version) this.client.version = String(version);
    if (this.queue.length > 0) return Promise.resolve(this.queue.splice(0, 10));
    return new Promise((resolve) => {
      const waiter = { resolve: (commands) => { clearTimeout(timer); resolve(commands); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve([]);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async sendCommand(op, args = {}, timeoutMs = 20000) {
    await this.waitForClient();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const entry = new PendingCommand(timeoutMs, op, (error) => {
        this.pending.delete(id);
        reject(error);
      });
      this.pending.set(id, { resolve, reject, entry });
    });
    this.#deliver({ id, op, args });
    return promise;
  }

  handleResult(body) {
    const id = body && body.id;
    const record = this.pending.get(id);
    if (!record) return;
    this.pending.delete(id);
    record.entry.settle();
    if (body.ok) record.resolve(body.value);
    else record.reject(new Error(String(body.error || '浏览器命令失败')));
  }

  setPageState(pageState) {
    const previous = this.state;
    this.state = {
      ...previous,
      url: typeof pageState.url === 'string' ? pageState.url : previous.url,
      title: typeof pageState.title === 'string' ? pageState.title : previous.title,
      loading: Boolean(pageState.loading),
      ready: true,
      canGoBack: pageState.canGoBack === true,
      canGoForward: pageState.canGoForward === true,
    };
    if (pageState.viewport && Number(pageState.viewport.width) > 0) {
      this.state.viewport = { width: Math.round(pageState.viewport.width), height: Math.round(pageState.viewport.height) };
    }
  }

  setProbe(probe) {
    this.probe = probe;
  }

  dispose() {
    for (const waiter of this.waiters) {
      try { waiter.resolve([]); } catch {}
    }
    this.waiters = [];
    for (const [, record] of this.pending) {
      record.entry.settle();
      record.reject(new Error('浏览器桥接已关闭'));
    }
    this.pending.clear();
    this.queue = [];
  }
}

/**
 * Duck-typed stand-in for the headless BrowserSession: the Host tools call the same
 * method names, and every call becomes one command on the native webview guest.
 */
export class WebviewSession {
  constructor(config = {}) {
    this.config = config;
    this.bridge = new WebviewBridge(config);
    this.lastFrame = null;
  }

  get state() {
    return this.bridge.state;
  }

  get probe() {
    return this.bridge.probe;
  }

  get hello() {
    return this.bridge.hello;
  }

  get lastRevealAt() {
    return this.bridge.lastRevealAt;
  }

  async probeLive() {
    const live = await this.bridge.sendCommand('probe', {}, 8000).catch(() => null);
    if (live && typeof live === 'object') {
      const previous = this.bridge.probe || {};
      this.bridge.setProbe({ ...previous, ...live, at: Date.now() });
    }
    return this.bridge.probe;
  }

  async ensure() {
    await this.bridge.waitForClient();
    return this;
  }

  touch() {}

  dispose() {
    this.bridge.dispose();
  }

  async hardClose() {
    // Native driver: closing the owning sidebar tab unmounts the guest and frees it.
    try { await this.bridge.sendCommand('close', {}, 6000); } catch {}
    this.bridge.state.ready = false;
    return { ok: true };
  }

  async navigate(url) {
    const result = await this.bridge.sendCommand('open', { url }, 30000);
    if (result && result.state) this.bridge.setPageState(result.state);
    return { ...this.state };
  }

  async evaluate(code) {
    const result = await this.bridge.sendCommand('evaluate', { code });
    return result ? result.value : undefined;
  }

  async listTabs(closeExtras = false) {
    try {
      return await this.bridge.sendCommand('tabs', { close: Boolean(closeExtras) }, 15000);
    } catch (error) {
      return { error: String(error && error.message ? error.message : error), tabs: [] };
    }
  }

  async setReveal(allow) {
    return this.bridge.sendCommand('reveal', { allow: Boolean(allow) }, 8000);
  }

  async expand(url) {
    return this.bridge.sendCommand('expand', { url: String(url || '') }, 8000);
  }

  async setZoom(factor) {
    return this.bridge.sendCommand('zoom', { factor: Number(factor) }, 8000);
  }

  async switchTab(tabId) {
    return this.bridge.sendCommand('tab-switch', { tabId: String(tabId || '') }, 20000);
  }

  async newTab(url) {
    return this.bridge.sendCommand('tab-new', { url: String(url || '') }, 25000);
  }

  async closeTab(tabId) {
    return this.bridge.sendCommand('tab-close', { tabId: String(tabId || '') }, 20000);
  }

  async sweepStale() {
    try {
      return await this.bridge.sendCommand('sweep-stale', {}, 12000);
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  async sweep() {
    try {
      return await this.bridge.sendCommand('sweep', {}, 10000);
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  async focusUrl(url) {
    try {
      return await this.bridge.sendCommand('focus', { url: String(url || '') }, 6000);
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  async pageDiagnostics(mode = 'report') {
    return this.bridge.sendCommand('page-diag', { mode }, 8000);
  }

  async snapshot() {
    const result = await this.bridge.sendCommand('snapshot', {}, 20000);
    return result || { elements: [], text: '' };
  }

  async clickRef(ref) {
    return this.bridge.sendCommand('click', { ref: Number(ref) });
  }

  async typeRef(ref, text, clear = false, submit = false) {
    return this.bridge.sendCommand('type', { ref: Number(ref), text, clear, submit });
  }

  async pressKey(name) {
    return this.bridge.sendCommand('press', { key: String(name) });
  }

  async scroll(deltaY) {
    return this.bridge.sendCommand('scroll', { deltaY: Number(deltaY) || 0 });
  }

  async back() { await this.bridge.sendCommand('back'); return { ...this.state }; }
  async forward() { await this.bridge.sendCommand('forward'); return { ...this.state }; }
  async reload() { await this.bridge.sendCommand('reload'); return { ...this.state }; }

  async screenshot(name = 'shot') {
    const result = await this.bridge.sendCommand('screenshot', {}, 15000);
    const dataUrl = result && result.dataUrl;
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('浏览器面板没有返回截图');
    }
    const base64 = dataUrl.slice('data:image/png;base64,'.length);
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${name}-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(base64, 'base64'));
    return { file, bytes: Math.round((base64.length * 3) / 4) };
  }

  setViewport() {
    return this.state;
  }

  noteVisibility() {}
}
