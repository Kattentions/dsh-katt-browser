/**
 * katt-browser — CDP driver (host half).
 *
 * Talks to the Electron app's Chromium DevTools endpoint (started with
 * --remote-debugging-port). One WebSocket connection to the browser endpoint,
 * flat session attach per webview guest, so page structure comes from the
 * accessibility tree and DOM snapshot instead of in-page JavaScript guessing.
 */
const PROBE_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS = 20000;

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCdp(port) {
  const ports = port ? [Number(port)] : [9222, 9223, 9229];
  for (const candidate of ports) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${candidate}/json/version`, PROBE_TIMEOUT_MS);
      if (version && typeof version.webSocketDebuggerUrl === 'string') {
        return { port: candidate, webSocketDebuggerUrl: version.webSocketDebuggerUrl, browser: version.Browser || '' };
      }
    } catch {}
  }
  return null;
}

class Pending {
  constructor(timeoutMs, method, reject) {
    this.timer = setTimeout(() => {
      reject(new Error(`CDP 命令超时：${method}`));
    }, timeoutMs);
  }

  settle() {
    clearTimeout(this.timer);
  }
}

export class CdpConnection {
  constructor(webSocketDebuggerUrl) {
    this.url = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
    this.ready = null;
  }

  open() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      const fail = (error) => {
        for (const [, record] of this.pending) {
          record.entry.settle();
          record.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.pending.clear();
      };
      socket.addEventListener('open', () => resolve(this));
      socket.addEventListener('error', (event) => {
        const error = new Error(`CDP 连接失败：${event.message || event.type}`);
        fail(error);
        reject(error);
      });
      socket.addEventListener('close', () => {
        fail(new Error('CDP 连接已断开'));
        this.ready = null;
        this.socket = null;
      });
      socket.addEventListener('message', (event) => this.#onMessage(event.data));
    });
    return this.ready;
  }

  #onMessage(data) {
    let message;
    try { message = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (message.id !== undefined) {
      const record = this.pending.get(message.id);
      if (!record) return;
      this.pending.delete(message.id);
      record.entry.settle();
      if (message.error) record.reject(new Error(`${message.error.message || 'CDP 错误'}${message.error.code ? ` (${message.error.code})` : ''}`));
      else record.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      const handlers = this.listeners.get(message.method);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try { handler(message.params || {}, message.sessionId); } catch {}
      }
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const entry = new Pending(COMMAND_TIMEOUT_MS, method, reject);
      this.pending.set(id, { resolve, reject, entry });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        entry.settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method, handler) {
    let handlers = this.listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  once(method, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      const dispose = this.on(method, (params, sessionId) => {
        clearTimeout(timer);
        dispose();
        resolve(params);
      });
      timer = setTimeout(() => {
        dispose();
        resolve(null);
      }, timeoutMs);
    });
  }

  close() {
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.ready = null;
  }
}

const SAME_TAB_SOURCE = `(() => {
  try {
    // Fade-in is idempotent and must run even when an older injected copy already claimed the
    // policy flag, so it sits before the guard.
    const installFade = () => {
      try {
        if (document.getElementById('__katt_fade_style')) return;
        const fade = document.createElement('style');
        fade.id = '__katt_fade_style';
        fade.textContent = '@keyframes __kattFadeIn{from{opacity:.86}to{opacity:1}}html{animation:__kattFadeIn .12s cubic-bezier(.25,.8,.25,1) both}';
        (document.head || document.documentElement).appendChild(fade);
      } catch {}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installFade, { once: true });
    else installFade();
    // The sidebar session denies every permission request, so navigator.clipboard.writeText
    // rejects with NotAllowedError even though execCommand('copy') reaches the OS clipboard.
    // Route the async Clipboard API through the legacy path so page copy buttons work.
    const installClipboard = () => {
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard || window.__kattClipboard) return;
        window.__kattClipboard = true;
        const copyText = (text) => {
          const area = document.createElement('textarea');
          area.value = String(text == null ? '' : text);
          area.setAttribute('readonly', '');
          area.style.cssText = 'position:fixed;top:-2000px;left:-2000px;opacity:0;pointer-events:none';
          const active = document.activeElement;
          (document.body || document.documentElement).appendChild(area);
          area.focus();
          area.select();
          let ok = false;
          try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
          try { area.remove(); } catch (error) {}
          try { if (active && typeof active.focus === 'function') active.focus(); } catch (error) {}
          if (!ok) throw new Error('clipboard write denied');
        };
        Object.defineProperty(clipboard, 'writeText', {
          configurable: true,
          writable: true,
          value: (text) => Promise.resolve().then(() => copyText(text)),
        });
        if (typeof clipboard.write === 'function') {
          Object.defineProperty(clipboard, 'write', {
            configurable: true,
            writable: true,
            value: (items) => Promise.resolve().then(async () => {
              for (const item of Array.from(items || [])) {
                if (item && item.types && item.types.indexOf('text/plain') !== -1) {
                  return copyText(await item.getType('text/plain').then((blob) => blob.text()));
                }
              }
              throw new Error('unsupported clipboard item');
            }),
          });
        }
      } catch (error) {}
    };
    installClipboard();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installClipboard, { once: true });
    if (window.__kattSameTabPolicy) return;
    window.__kattSameTabPolicy = true;
    const navigate = (value) => {
      try { location.assign(String(value && value.href ? value.href : value)); } catch {}
    };
    const makeWindowShim = () => new Proxy({}, {
      get(_target, prop) {
        if (prop === 'location') {
          return new Proxy({}, {
            get(_t, key) {
              if (key === 'assign' || key === 'replace' || key === 'reload') return (value) => navigate(value);
              return undefined;
            },
            set(_t, key, value) { if (key === 'href' || key === 'toString') navigate(value); return true; },
          });
        }
        if (prop === 'focus' || prop === 'close' || prop === 'blur') return () => {};
        if (prop === 'closed') return false;
        return undefined;
      },
      set() { return true; },
    });
    // window.open() with no URL followed by win.location = ... is a common popup pattern;
    // fold it into the current tab instead of letting the shell create a placeholder tab.
    window.open = function (url) {
      if (url) navigate(url);
      return makeWindowShim();
    };
    const nativeAnchorClick = HTMLAnchorElement.prototype.click;
    if (nativeAnchorClick) {
      HTMLAnchorElement.prototype.click = function () {
        try { if (this.target && this.target.toLowerCase() !== '_self') this.target = '_self'; } catch {}
        return nativeAnchorClick.apply(this, arguments);
      };
    }
    document.addEventListener('click', (event) => {
      const target = event.target;
      const anchor = target && target.closest ? target.closest('a[target]') : null;
      if (anchor && anchor.target && anchor.target.toLowerCase() !== '_self') anchor.target = '_self';
    }, true);
    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (form && form.target && form.target.toLowerCase() !== '_self') form.target = '_self';
    }, true);
    const nativeSubmit = HTMLFormElement.prototype.submit;
    if (nativeSubmit) {
      // form.submit() skips the submit event, so programmatic submissions need their own guard.
      HTMLFormElement.prototype.submit = function () {
        try { if (this.target && this.target.toLowerCase() !== '_self') this.target = '_self'; } catch {}
        return nativeSubmit.apply(this, arguments);
      };
    }
  } catch {}
})();`;

// Installed before page scripts: captures worker traffic and storage writes, which is how
// canvas/worker games expose their state without any screenshot.
const INSTRUMENT_SOURCE = `(() => {
  try {
    if (window.__kattInstrument2) return;
    const buf = (window.__kattInstrument2 = { workers: [], out: [], in: [], storage: [], net: [] });
    const push = (list, entry, limit) => { list.push(entry); if (list.length > limit) list.shift(); };
    const NativeWorker = window.Worker;
    if (NativeWorker) {
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          try { buf.workers.push(String(url)); } catch {}
          const post = this.postMessage.bind(this);
          this.postMessage = (message, ...rest) => {
            try { push(buf.out, { at: Date.now(), message }, 20); } catch {}
            return post(message, ...rest);
          };
          this.addEventListener('message', (event) => {
            try { push(buf.in, { at: Date.now(), message: event.data }, 20); } catch {}
          });
        }
      };
    }
    if (window.fetch) {
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const record = { at: Date.now(), kind: 'fetch', url: String(url).slice(0, 300), method: String(method) };
        try { push(buf.net, record, 40); } catch {}
        const result = nativeFetch.apply(this, arguments);
        try {
          result.then((response) => {
            record.status = response.status;
            try {
              const contentType = response.headers.get('content-type') || '';
              record.contentType = contentType.split(';')[0].slice(0, 60);
              // Only small JSON bodies get a preview: cloning every script or large text
              // response doubled the page's download work for data nobody reads.
              const length = Number(response.headers.get('content-length') || 0);
              if (/json/i.test(contentType) && (!length || length <= 262144)) {
                response.clone().text().then((text) => {
                  record.preview = String(text).replace(/[\\u0000-\\u001f]+/g, ' ').slice(0, 300);
                }).catch(() => {});
              }
            } catch {}
          }).catch((error) => { record.error = String(error && error.message || error); });
        } catch {}
        return result;
      };
    }
    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__kattRequest = { method: String(method), url: String(url).slice(0, 300) };
      return xhrOpen.apply(this, arguments);
    };
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      const request = this.__kattRequest;
      if (request) {
        const record = { at: Date.now(), kind: 'xhr', url: request.url, method: request.method };
        try { push(buf.net, record, 40); } catch {}
        this.addEventListener('load', () => {
          record.status = this.status;
          try {
            const contentType = this.getResponseHeader('content-type') || '';
            record.contentType = contentType.split(';')[0].slice(0, 60);
            if (/json|text|xml|javascript/i.test(contentType)) {
              record.preview = String(this.responseText || '').slice(0, 262144).replace(/[\\u0000-\\u001f]+/g, ' ').slice(0, 300);
            }
          } catch {}
        });
      }
      return xhrSend.apply(this, arguments);
    };
    const NativeSocket = window.WebSocket;
    if (NativeSocket) {
      window.WebSocket = class extends NativeSocket {
        constructor(url, protocols) {
          super(url, protocols);
          const record = { at: Date.now(), kind: 'websocket', url: String(url).slice(0, 300), messages: 0 };
          try { push(buf.net, record, 40); } catch {}
          this.addEventListener('message', (event) => {
            try { record.messages += 1; record.last = String(event.data).slice(0, 200); } catch {}
          });
        }
      };
    }
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      try { push(buf.storage, { key: String(key), value: String(value).slice(0, 160) }, 10); } catch {}
      return setItem.call(this, key, value);
    };
  } catch {}
})();`;
// Chrome-style loading hint: a 2px indeterminate bar at the top edge and nothing else.
// The older version dimmed and blurred the whole page, which is actually expensive to
// composite on a phone-ish webview and reads as a flash rather than a progress cue.
const TRANSITION_SOURCE = `(() => {
  try {
    if (document.getElementById('__katt_transition')) return;
    const style = document.createElement('style');
    style.id = '__katt_transition_style';
    style.textContent = [
      '@keyframes kattSweep{0%{transform:translateX(-110%)}55%{transform:translateX(35%)}100%{transform:translateX(110%)}}',
      '#__katt_transition{position:fixed;left:0;top:0;right:0;height:2px;z-index:2147483647;pointer-events:none;overflow:hidden;opacity:0;transition:opacity .12s ease}',
      '#__katt_transition.visible{opacity:1}',
      '#__katt_transition::before,#__katt_transition::after{content:"";position:absolute;top:0;left:0;height:100%;width:45%;',
      'background:linear-gradient(90deg,transparent,#4f8cff 60%,#a8d6ff);animation:kattSweep 1.05s cubic-bezier(.25,.8,.25,1) infinite}',
      '#__katt_transition::after{width:28%;background:linear-gradient(90deg,transparent,#2f6fd0);animation-delay:.34s;opacity:.85}',
    ].join('');
    const overlay = document.createElement('div');
    overlay.id = '__katt_transition';
    (document.documentElement || document.body).appendChild(style);
    (document.documentElement || document.body).appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
    return 'shown';
  } catch { return 'failed'; }
})();`;

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'switch', 'tab',
]);
const TEXT_ROLES = new Set(['heading', 'text', 'statictext', 'img', 'image', 'listitem', 'cell', 'row']);
const STATE_PROPS = new Set(['disabled', 'checked', 'expanded', 'required', 'selected', 'pressed', 'level']);

function clean(value, limit = 120) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

/**
 * One attached webview guest: AX-tree snapshots, refs, input, navigation.
 */
export class CdpSession {
  constructor(connection, sessionId, targetId, options = {}) {
    this.connection = connection;
    this.options = options;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.refs = new Map();
    this.nextRef = 1;
    this.lastAx = [];
    this.lastInputAt = 0;
    this.pendingPopups = new Set();
    this.consoleBuffer = [];
    this.networkBuffer = [];
    this.networkPending = new Map();
    this.foldedPopups = 0;
    this.ready = false;
    this.focusEmulated = false;
    this.focusTimer = null;
  }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  async setFocusEmulation(enabled) {
    const want = Boolean(enabled);
    if (this.focusEmulated === want) return;
    this.focusEmulated = want;
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: want }).catch(() => {});
  }

  // Keyboard and insertText input only reach an unfocused guest under focus emulation, but
  // leaving it on disables Chromium's occlusion throttling, so it lives for a few seconds.
  touchFocus() {
    clearTimeout(this.focusTimer);
    this.setFocusEmulation(true);
    this.focusTimer = setTimeout(() => { this.focusTimer = null; this.setFocusEmulation(false); }, 4000);
    this.focusTimer.unref?.();
  }

  async setPageZoom(factor) {
    const value = Math.min(5, Math.max(0.25, Number(factor) || 1));
    try {
      await this.send('Emulation.setPageScaleFactor', { pageScaleFactor: value });
      return { ok: true, factor: value, mode: 'page-scale' };
    } catch (error) {
      await this.send('Runtime.evaluate', {
        expression: 'document.documentElement.style.zoom=' + JSON.stringify(String(value)),
      });
      return { ok: true, factor: value, mode: 'css' };
    }
  }

  async detach() {
    clearTimeout(this.focusTimer);
    this.focusTimer = null;
    try { this.connection.close(); } catch {}
  }

  async init() {
    if (this.ready) return this;
    await this.send('Page.enable');
    await this.send('DOM.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable').catch(() => {});
    const own = (method, handler) => this.connection.on(method, (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      try { handler(params || {}); } catch {}
    });
    const clip = (value, max = 300) => String(value === undefined || value === null ? '' : value).slice(0, max);
    own('Runtime.consoleAPICalled', (params) => {
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args.map((arg) => (arg && arg.value !== undefined ? String(arg.value) : arg && arg.description ? String(arg.description) : arg && arg.type ? `<${arg.type}>` : '')).join(' ').trim();
      this.consoleBuffer.push({ at: Date.now(), kind: 'console', type: params.type || 'log', text: clip(text, 400) });
      if (this.consoleBuffer.length > 300) this.consoleBuffer.shift();
    });
    own('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const text = details.exception && (details.exception.description || details.exception.value) || details.text || 'Unknown error';
      this.consoleBuffer.push({ at: Date.now(), kind: 'exception', type: 'error', text: clip(text, 400), url: clip(details.url, 200), line: details.lineNumber });
      if (this.consoleBuffer.length > 300) this.consoleBuffer.shift();
    });
    own('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      this.consoleBuffer.push({ at: Date.now(), kind: 'log', type: entry.level || 'info', text: clip(entry.text, 400), url: clip(entry.url, 200) });
      if (this.consoleBuffer.length > 300) this.consoleBuffer.shift();
    });
    own('Network.requestWillBeSent', (params) => {
      this.networkPending.set(params.requestId, {
        at: Date.now(),
        method: params.request && params.request.method || 'GET',
        url: clip(params.request && params.request.url, 500),
        type: params.type || '',
      });
    });
    const flushNetwork = (requestId, patch) => {
      const pending = this.networkPending.get(requestId);
      if (!pending) return;
      this.networkPending.delete(requestId);
      this.networkBuffer.push({ ...pending, ...patch, durationMs: Date.now() - pending.at });
      if (this.networkBuffer.length > 400) this.networkBuffer.shift();
    };
    own('Network.responseReceived', (params) => {
      const response = params.response || {};
      flushNetwork(params.requestId, { status: response.status, mimeType: clip(response.mimeType, 80), from: response.fromDiskCache ? 'cache' : 'network' });
    });
    own('Network.loadingFailed', (params) => {
      flushNetwork(params.requestId, { status: 0, error: clip(params.errorText, 160) });
    });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: SAME_TAB_SOURCE, runImmediately: true }).catch(() => {});
    // Focus emulation is turned on only around keyboard/insert input: left on, Chromium stops
    // throttling the occluded guest, which keeps the whole app's compositor busy for no reason.
    if (this.options.instrument !== false) await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT_SOURCE }).catch(() => {});
    await this.connection.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    this.connection.on('Target.targetCreated', (params) => this.#onTargetCreated(params));
    this.connection.on('Target.targetInfoChanged', (params) => this.#onTargetChanged(params));
    this.ready = true;
    return this;
  }

  async state() {
    try {
      const { frameTree } = await this.send('Page.getFrameTree');
      const frame = frameTree?.frame || {};
      const metrics = await this.send('Page.getLayoutMetrics').catch(() => null);
      const viewport = metrics?.cssVisualViewport
        ? { width: Math.round(metrics.cssVisualViewport.clientWidth), height: Math.round(metrics.cssVisualViewport.clientHeight) }
        : { width: 0, height: 0 };
      return {
        url: frame.url || '',
        title: frame.title || '',
        loading: false,
        ready: true,
        viewport,
        canGoBack: false,
        canGoForward: false,
      };
    } catch {
      return { url: '', title: '', loading: false, ready: false, viewport: { width: 0, height: 0 } };
    }
  }

  /**
   * Links that force a new window create a fresh webview target (first as a leased
   * about:blank, then the real URL). Redirect this tab to that URL and close the extra
   * target so the panel keeps a single browsing tab.
   */
  #onTargetCreated(params) {
    const info = params && params.targetInfo;
    if (!info || !info.targetId || info.targetId === this.targetId) return;
    if (info.type !== 'page' && info.type !== 'webview') return;
    if (Date.now() - this.lastInputAt > 8000) return;
    this.pendingPopups.add(info.targetId);
  }

  #onTargetChanged(params) {
    const info = params && params.targetInfo;
    if (!info || !info.targetId) return;
    if (info.targetId === this.targetId) return;
    if (!this.pendingPopups.has(info.targetId)) return;
    if (!/^https?:/i.test(info.url || '')) return;
    this.pendingPopups.delete(info.targetId);
    this.foldedPopups += 1;
    this.lastInputAt = 0;
    const url = info.url;
    // Fade the current page into a subtle "opening" state, then swap it. The placeholder tab
    // the shell creates for a popup is closed at the same time, so the handoff looks intentional.
    this.send('Runtime.evaluate', { expression: TRANSITION_SOURCE }).catch(() => {});
    this.connection.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    setTimeout(() => {
      this.send('Runtime.evaluate', {
        expression: `setTimeout(() => location.assign(${JSON.stringify(url)}), 120)`,
        userGesture: true,
      }).catch(() => {});
    }, 140);
  }
  async #axNodes() {
    const { nodes } = await this.send('Accessibility.getFullAXTree');
    return nodes || [];
  }

  async #viewportOffset() {
    try {
      const { result } = await this.send('Runtime.evaluate', {
        expression: '({x: scrollX || 0, y: scrollY || 0, w: innerWidth || 0, h: innerHeight || 0})',
        returnByValue: true,
        silent: true,
      });
      return result.value || { x: 0, y: 0, w: 0, h: 0 };
    } catch {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  async cookies() {
    const result = await this.send('Network.getCookies');
    return result.cookies || [];
  }

  async setCookies(cookies) {
    await this.send('Network.setCookies', { cookies });
  }

  async clearCookies() {
    await this.send('Network.clearBrowserCookies');
  }

  async clearCache() {
    await this.send('Network.clearBrowserCache');
  }

  async clearSiteData(origin) {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(async () => {
      await this.send('Network.clearBrowserCache');
    });
  }

  async origin() {
    const state = await this.state();
    try { return new URL(state.url).origin; } catch { return ''; }
  }

  async storageSnapshot() {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(async () => {
        const idbLimit = ${Number(this.options.idbLimit) || 50};
        const out = { origin: location.origin, local: {}, session: {}, idb: [], caches: [] };
        try {
          const cacheNames = (await caches.keys()).slice(0, 5);
          let totalBytes = 0;
          for (const name of cacheNames) {
            const cache = await caches.open(name);
            const requests = await cache.keys();
            const entries = [];
            for (const request of requests.slice(0, 25)) {
              if (totalBytes > 1500000) break;
              const response = await cache.match(request);
              if (!response) continue;
              const buffer = await response.clone().arrayBuffer();
              if (buffer.byteLength > 262144) continue;
              totalBytes += buffer.byteLength;
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let index = 0; index < bytes.length; index += 0x8000) {
                binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
              }
              entries.push({
                url: request.url,
                status: response.status,
                headers: [...response.headers].slice(0, 20),
                body: btoa(binary),
              });
            }
            out.caches.push({ name, entries });
          }
        } catch {}
        try { out.local = Object.fromEntries(Object.entries(localStorage).slice(0, 200)); } catch {}
        try { out.session = Object.fromEntries(Object.entries(sessionStorage).slice(0, 200)); } catch {}
        let databases = [];
        try { databases = await indexedDB.databases(); } catch {}
        // Page through each store so a database with more rows than idbLimit is not silently
        // truncated; the total is still bounded to keep the tool result a sane size.
        const maxPerStore = Math.max(idbLimit, 500);
        for (const info of databases.slice(0, 5)) {
          if (!info || !info.name) continue;
          const dump = await new Promise((resolve) => {
            let request;
            try { request = info.version ? indexedDB.open(info.name, info.version) : indexedDB.open(info.name); } catch { resolve(null); return; }
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
            request.onsuccess = () => {
              const db = request.result;
              const names = [...db.objectStoreNames];
              const result = { name: db.name, version: db.version, stores: [] };
              if (names.length === 0) { try { db.close(); } catch {} ; resolve(result); return; }
              let remaining = names.length;
              const finish = () => { remaining -= 1; if (remaining === 0) { try { db.close(); } catch {} ; resolve(result); } };
              for (const storeName of names) {
                const readPage = (offset) => new Promise((res) => {
                  const entries = [];
                  try {
                    const cursorRequest = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
                    let skipped = 0;
                    cursorRequest.onsuccess = (event) => {
                      const cursor = event.target.result;
                      if (!cursor) { res(entries); return; }
                      if (skipped < offset) { skipped += 1; cursor.advance(1); return; }
                      let value = null;
                      let key;
                      try { value = JSON.parse(JSON.stringify(cursor.value)); } catch {}
                      try { key = JSON.parse(JSON.stringify(cursor.primaryKey)); } catch {}
                      entries.push({ key, value });
                      if (entries.length >= idbLimit) { res(entries); return; }
                      cursor.continue();
                    };
                    cursorRequest.onerror = () => res(entries);
                  } catch { res(entries); }
                });
                (async () => {
                  const entries = [];
                  let offset = 0;
                  while (entries.length < maxPerStore) {
                    const page = await readPage(offset);
                    entries.push(...page);
                    if (page.length < idbLimit) break;
                    offset += page.length;
                  }
                  result.stores.push({ name: storeName, entries });
                  finish();
                })().catch(() => finish());
              }
            };
          });
          if (dump) out.idb.push(dump);
        }
        return JSON.stringify(out);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) return null;
    try { return result?.value ? JSON.parse(result.value) : null; } catch { return null; }
  }

  async restoreStorage(snapshot) {
    if (!snapshot || !snapshot.origin) return false;
    const payload = JSON.stringify({
      origin: snapshot.origin,
      local: snapshot.local || {},
      session: snapshot.session || {},
      idb: snapshot.idb || [],
      caches: snapshot.caches || [],
    });
    const { result } = await this.send('Runtime.evaluate', {
      expression: `(async () => {
        const snapshot = ${payload};
        if (location.origin !== snapshot.origin) return false;
        try {
          for (const [key, value] of Object.entries(snapshot.local)) localStorage.setItem(key, value);
          for (const [key, value] of Object.entries(snapshot.session)) sessionStorage.setItem(key, value);
        } catch {}
        for (const info of snapshot.idb) {
          await new Promise((resolve) => {
            let request;
            try { request = info.version ? indexedDB.open(info.name, info.version) : indexedDB.open(info.name); } catch { resolve(false); return; }
            request.onupgradeneeded = () => {
              const db = request.result;
              for (const store of info.stores || []) {
                if (!db.objectStoreNames.contains(store.name)) { try { db.createObjectStore(store.name); } catch {} }
              }
            };
            request.onerror = () => resolve(false);
            request.onblocked = () => resolve(false);
            request.onsuccess = () => {
              const db = request.result;
              const stores = (info.stores || []).filter((store) => db.objectStoreNames.contains(store.name) && (Array.isArray(store.entries) || Array.isArray(store.records)));
              if (stores.length === 0) { try { db.close(); } catch {} ; resolve(true); return; }
              let remaining = stores.length;
              const finish = () => { remaining -= 1; if (remaining === 0) { try { db.close(); } catch {} ; resolve(true); } };
              for (const store of stores) {
                try {
                  const transaction = db.transaction(store.name, 'readwrite');
                  const target = transaction.objectStore(store.name);
                  const entries = Array.isArray(store.entries) ? store.entries : (store.records || []).map((value) => ({ value }));
                  for (const entry of entries) {
                    if (!entry || entry.value === null || entry.value === undefined) continue;
                    try { target.put(entry.value, entry.key); continue; } catch {}
                    try { target.put(entry.value); } catch {}
                  }
                  transaction.oncomplete = finish;
                  transaction.onerror = finish;
                  transaction.onabort = finish;
                } catch { finish(); }
              }
            };
          });
        }
        for (const info of snapshot.caches || []) {
          try {
            const cache = await caches.open(info.name);
            for (const entry of info.entries || []) {
              if (!entry || !entry.url || !entry.body) continue;
              try {
                const bytes = Uint8Array.from(atob(entry.body), (char) => char.charCodeAt(0));
                await cache.put(entry.url, new Response(bytes, {
                  status: entry.status || 200,
                  headers: entry.headers || {},
                }));
              } catch {}
            }
          } catch {}
        }
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return Boolean(result?.value);
  }

  async fetchResource(url, maxBytes = 8 * 1024 * 1024) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(async () => {
        const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        const buffer = await response.arrayBuffer();
        const limit = ${Number(maxBytes)};
        const bytes = new Uint8Array(buffer);
        if (bytes.byteLength > limit) return JSON.stringify({ error: 'too-large', size: bytes.byteLength, limit });
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
        }
        return JSON.stringify({
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          filename: (response.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1] || null,
          size: bytes.byteLength,
          base64: btoa(binary),
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || '下载失败');
    if (!result?.value) throw new Error('下载没有返回数据');
    const payload = JSON.parse(result.value);
    if (payload.error) throw new Error(`文件太大：${payload.size} 字节，上限 ${payload.limit}`);
    return payload;
  }

  consoleLogs(limit = 50, level) {
    const entries = level ? this.consoleBuffer.filter((item) => item.type === level) : this.consoleBuffer;
    return { total: this.consoleBuffer.length, count: entries.length, entries: entries.slice(-Math.max(1, Number(limit) || 50)) };
  }

  networkLogs(limit = 50, filter) {
    const needle = filter ? String(filter).toLowerCase() : '';
    const entries = needle ? this.networkBuffer.filter((item) => String(item.url).toLowerCase().includes(needle)) : this.networkBuffer;
    return { total: this.networkBuffer.length, count: entries.length, entries: entries.slice(-Math.max(1, Number(limit) || 50)) };
  }

  clearConsole() {
    const removed = this.consoleBuffer.length;
    this.consoleBuffer = [];
    return { cleared: removed };
  }

  clearNetwork() {
    const removed = this.networkBuffer.length;
    this.networkBuffer = [];
    this.networkPending.clear();
    return { cleared: removed };
  }

  async hoverAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(x), y: Number(y), button: 'none' });
    return { ok: true, x: Number(x), y: Number(y) };
  }

  async clickAt(x, y, clicks = 1) {
    this.touchFocus();
    const point = { x: Number(x), y: Number(y), button: 'left', clickCount: Math.max(1, Number(clicks) || 1) };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    return { ok: true, x: point.x, y: point.y };
  }

  async setFiles(selector, files) {
    this.touchFocus();
    const list = Array.isArray(files) ? files.map(String) : [String(files || '')];
    if (list.length === 0 || !list[0]) throw new Error('需要文件路径');
    const { root } = await this.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector: String(selector) });
    if (!nodeId) throw new Error('找不到文件输入框：' + selector);
    await this.send('DOM.setFileInputFiles', { files: list, nodeId });
    return { ok: true, count: list.length, selector };
  }

  async scrollIntoView(selector) {
    const { result } = await this.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true; })()`,
      returnByValue: true,
    });
    return { ok: Boolean(result?.value), selector };
  }

  async instrumentData() {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const buf = window.__kattInstrument2 || { workers: [], out: [], in: [], storage: [] };
        return { workers: buf.workers, storage: buf.storage.slice(-5), out: buf.out.slice(-4), inCount: buf.in.length, net: (buf.net || []).slice(-8) };
      })())`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || '读取失败');
    return result?.value ? JSON.parse(result.value) : null;
  }

  async snapshot({ full = false, detail = 'full' } = {}) {
    const compact = detail === 'compact';
    const limit = compact ? 200 : 400;
    const [nodes, viewport] = await Promise.all([this.#axNodes(), this.#viewportOffset()]);
    this.lastAx = nodes;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
    const lines = [];
    const elements = [];
    const stack = roots.slice().reverse().map((node) => ({ node, depth: 0 }));
    const seen = new Set();
    while (stack.length > 0) {
      const { node, depth } = stack.pop();
      if (seen.has(node.nodeId)) continue;
      seen.add(node.nodeId);
      if (node.ignored) {
        for (const childId of (node.childIds || []).slice().reverse()) {
          const child = byId.get(childId);
          if (child) stack.push({ node: child, depth });
        }
        continue;
      }
      const role = clean(node.role?.value, 40).toLowerCase() || 'generic';
      const name = clean(node.name?.value);
      const value = clean(node.value?.value, 80);
      const props = (node.properties || [])
        .filter((property) => STATE_PROPS.has(property.name) && property.value?.value !== undefined && property.value?.value !== false)
        .map((property) => (property.value.value === true ? property.name : `${property.name}=${String(property.value.value)}`));
      const interactive = INTERACTIVE_ROLES.has(role);
      const textish = TEXT_ROLES.has(role) && name;
      const keep = interactive || (!compact && textish);
      let ref = null;
      if (keep) {
        if (interactive) {
          const backendNodeId = node.backendDOMNodeId;
          if (backendNodeId !== undefined) {
            if (!this.refs.has(backendNodeId)) this.refs.set(backendNodeId, this.nextRef++);
            ref = this.refs.get(backendNodeId);
          }
        }
        const suffix = [value ? ` value=${JSON.stringify(value)}` : '', props.length ? ` (${props.join(', ')})` : ''].join('');
        lines.push(`${'  '.repeat(depth)}${ref ? `[e${ref}] ` : ''}${role} ${JSON.stringify(name || '')}${suffix}`);
        if (ref !== null) elements.push({ ref, role, name, value, props, depth });
        if (full === false && lines.length >= limit) break;
      }
      for (const childId of (node.childIds || []).slice().reverse()) {
        const child = byId.get(childId);
        if (child) stack.push({ node: child, depth: depth + (keep ? 1 : 0) });
      }
    }
    /* Div-built pages (many Chinese course/admin sites) expose no ARIA roles: the
       expand arrow is an empty div with cursor:pointer. When the accessibility tree
       yields almost nothing, scan the DOM so the snapshot stays actionable. */
    const axLineCount = lines.length;
    let domCandidates = 0;
    if (elements.length < 5) {
      const extra = await this.#domClickables(compact ? 24 : 32).catch((error) => { this.domScanError = String((error && error.message) || error); return []; });
      for (const candidate of extra) {
        if (lines.length >= limit) break;
        if (elements.some((element) => element.ref === candidate.ref)) continue;
        lines.push(`${candidate.ref ? `[e${candidate.ref}] ` : ''}${candidate.role} ${JSON.stringify(candidate.name)} (dom, ${candidate.tag})`);
        elements.push(candidate);
        domCandidates += 1;
      }
    }
    let note = '';
    let text = lines.join('\n');
    if (compact && axLineCount === 0 && domCandidates > 0) {
      /* Div-only page: the refs are useful but the page text is the actual content,
         so hand over a short excerpt below the list instead of refs alone. */
      const excerpt = await this.#bodyText(1200).catch(() => '');
      if (excerpt) {
        text = text + '\n\n# 页面文本（div 页面，无 ARIA 角色）\n' + excerpt;
        note = 'eN 来自 DOM 可点击候选；正文从页面文本提取。';
      }
    }
    if (compact && elements.length === 0) {
      /* Nothing actionable and no roles: return readable text so the caller can still
         answer questions, and say why no refs came back. */
      const fallback = await this.#bodyText(4000).catch(() => '');
      if (fallback) {
        text = fallback;
        note = '该页面由 div 组成，无障碍树里没有可点击角色；下面是页面文本。要点击请用 browser_evaluate 找选择器或点坐标。';
      } else {
        note = '该页面没有可读文本，也没有可点击角色。';
      }
    }
    return {
      text,
      elements,
      nodeCount: nodes.length,
      domCandidates,
      ...(this.domScanError ? { domScanError: this.domScanError } : {}),
      ...(note ? { note } : {}),
      viewport,
      title: '',
      url: '',
      truncated: lines.length >= limit,
      detail: compact ? 'compact' : 'full',
    };
  }

  /**
   * Clickable elements that carry no accessibility role, found by DOM heuristics
   * (pointer cursor, inline handlers, tabindex, aria-expanded). Each one is marked
   * with a temporary attribute so it can be resolved to a backend node and given a
   * ref, which makes browser_click work on div-built pages too.
   *
   * @param {number} limit - most candidates to return.
   * @returns {Promise<Array<{ref: number, role: string, name: string, tag: string}>>}
   */
  async #domClickables(limit = 24) {
    const expression = `JSON.stringify((() => {
      const out = [];
      const seen = new Set();
      const elements = document.querySelectorAll('body *');
      for (const element of elements) {
        if (out.length >= ${Number(limit)}) break;
        const tag = element.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META' || tag === 'TEMPLATE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'PATH') continue;
        if (element.hasAttribute('role')) continue;
        if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY' || tag === 'OPTION') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 6 || rect.height < 6) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) continue;
        const clickable = style.cursor === 'pointer' || typeof element.onclick === 'function'
          || element.hasAttribute('onclick') || element.hasAttribute('aria-expanded')
          || element.hasAttribute('tabindex') || element.hasAttribute('data-action');
        if (!clickable) continue;
        const text = (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
        if (!text) continue;
        const key = text + '|' + Math.round(rect.top / 24);
        if (seen.has(key)) continue;
        seen.add(key);
        element.setAttribute('data-katt-click', String(out.length));
        out.push({ index: out.length, text, tag: tag.toLowerCase(), width: Math.round(rect.width), height: Math.round(rect.height) });
      }
      return out;
    })())`;
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    const result = response && response.result;
    let found = [];
    try { found = JSON.parse(result && result.value ? result.value : '[]'); } catch (error) { this.domScanError = 'parse: ' + String(error && error.message || error) + ' raw=' + String(result && result.value).slice(0, 120); found = []; }
    const out = [];
    const foundCount = found.length;
    if (found.length > 0) {
      try {
        const { root } = await this.send('DOM.getDocument', { depth: 0 });
        for (const candidate of found) {
          let nodeId = 0;
          try {
            const answer = await this.send('DOM.querySelector', {
              nodeId: root.nodeId,
              selector: `[data-katt-click="${candidate.index}"]`,
            });
            nodeId = answer && answer.nodeId;
          } catch (error) {
            this.domScanError = 'query: ' + String((error && error.message) || error);
          }
          if (!nodeId) continue;
          let backendNodeId;
          try {
            const { node } = await this.send('DOM.describeNode', { nodeId });
            backendNodeId = node && node.backendNodeId;
          } catch { backendNodeId = undefined; }
          if (backendNodeId === undefined) continue;
          if (!this.refs.has(backendNodeId)) this.refs.set(backendNodeId, this.nextRef++);
          out.push({
            ref: this.refs.get(backendNodeId),
            role: 'clickable',
            name: String(candidate.text || ''),
            tag: String(candidate.tag || ''),
            value: '',
            props: [],
            depth: 0,
          });
        }
      } finally {
        await this.send('Runtime.evaluate', {
          expression: 'document.querySelectorAll("[data-katt-click]").forEach(function (el) { el.removeAttribute("data-katt-click"); })',
        }).catch(() => {});
      }
    }
    if (out.length === 0 && !this.domScanError) this.domScanError = 'candidates=' + foundCount + ' refs=0';
    return out;
  }

  /** Resolves a CSS selector to an object id, or null when it does not match. */
  async #elementHandle(selector) {
    const { result } = await this.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)}) || null`,
    });
    return result?.objectId && result.subtype !== 'null' ? result.objectId : null;
  }

  /** Readable body text, used when a page has no accessibility structure at all. */
  async #bodyText(limit = 4000) {
    const { result } = await this.send('Runtime.evaluate', {
      expression: 'String((document.body && document.body.innerText) || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ' + Number(limit) + ')',
      returnByValue: true,
    });
    return String(result?.value || '').trim();
  }

  #backendForRef(ref) {
    for (const [backendNodeId, assigned] of this.refs) {
      if (assigned === Number(ref)) return backendNodeId;
    }
    return undefined;
  }

  async #centerOf(backendNodeId) {
    const { model } = await this.send('DOM.getBoxModel', { backendNodeId });
    const points = model?.border || model?.content;
    if (!points || points.length < 8) throw new Error('元素没有可见区域，无法点击');
    const xs = [points[0], points[2], points[4], points[6]];
    const ys = [points[1], points[3], points[5], points[7]];
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2), width: right - left, height: bottom - top };
  }

  async #scrollIntoView(backendNodeId) {
    try {
      const { object } = await this.send('DOM.resolveNode', { backendNodeId });
      await this.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "center" }); }',
        returnByValue: true,
      });
    } catch {}
  }

  async click(ref, { clickCount = 1, button = 'left' } = {}) {
    this.lastInputAt = Date.now();
    this.touchFocus();
    const backendNodeId = this.#backendForRef(ref);
    if (backendNodeId === undefined) throw new Error(`ref e${ref} 不存在，请重新 snapshot`);
    await this.#scrollIntoView(backendNodeId);
    const center = await this.#centerOf(backendNodeId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button, clickCount });
    return { ok: true, ref, x: center.x, y: center.y };
  }

  async #focus(backendNodeId) {
    const { object } = await this.send('DOM.resolveNode', { backendNodeId });
    await this.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { this.focus(); if (this.select) this.select(); }',
      returnByValue: true,
    });
    return object.objectId;
  }

  async type(ref, text, { clear = false, submit = false } = {}) {
    this.lastInputAt = Date.now();
    this.touchFocus();
    const backendNodeId = this.#backendForRef(ref);
    if (backendNodeId === undefined) throw new Error(`ref e${ref} 不存在，请重新 snapshot`);
    await this.#scrollIntoView(backendNodeId);
    await this.#focus(backendNodeId);
    if (clear) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    }
    await this.send('Input.insertText', { text });
    if (submit) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    return { ok: true, ref, typed: text.length, mode: 'cdp-insertText' };
  }

  async press(key) {
    this.lastInputAt = Date.now();
    this.touchFocus();
    const map = {
      Enter: { code: 'Enter', vk: 13, text: '\r' },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Backspace: { code: 'Backspace', vk: 8 },
      Delete: { code: 'Delete', vk: 46 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      ArrowRight: { code: 'ArrowRight', vk: 39 },
      PageUp: { code: 'PageUp', vk: 33 },
      PageDown: { code: 'PageDown', vk: 34 },
      Home: { code: 'Home', vk: 36 },
      End: { code: 'End', vk: 35 },
      Space: { code: 'Space', vk: 32, text: ' ' },
    };
    const spec = map[key];
    if (!spec) throw new Error('不支持的按键: ' + key);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: spec.code, windowsVirtualKeyCode: spec.vk, ...(spec.text ? { text: spec.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.vk });
    return { ok: true, key };
  }

  async scroll(deltaY) {
    const viewport = await this.#viewportOffset();
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round((viewport.w || 800) / 2),
      y: Math.round((viewport.h || 600) / 2),
      deltaX: 0,
      deltaY: Number(deltaY) || 0,
    });
    return { ok: true, deltaY: Number(deltaY) || 0 };
  }

  async waitFor(selector, timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
    while (Date.now() < deadline) {
      try {
        const { result } = await this.send('Runtime.evaluate', {
          expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
          returnByValue: true,
        });
        if (result?.value) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  async navigate(url) {
    const loaded = this.connection.once('Page.loadEventFired', 15000);
    // Soft handoff: show the dim + progress bar on the outgoing page before the swap.
    await this.send('Runtime.evaluate', { expression: TRANSITION_SOURCE }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 90));
    const result = await this.send('Page.navigate', { url });
    if (result && result.errorText) throw new Error(`打不开 ${url}：${result.errorText}`);
    await loaded;
    return this.state();
  }

  async reload() {
    const loaded = this.connection.once('Page.loadEventFired', 15000);
    await this.send('Page.reload', {});
    await loaded;
    return this.state();
  }

  async goBack() {
    await this.send('Runtime.evaluate', { expression: 'history.back()' });
    return this.state();
  }

  async goForward() {
    await this.send('Runtime.evaluate', { expression: 'history.forward()' });
    return this.state();
  }

  async evaluate(expression) {
    this.lastInputAt = Date.now();
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: String(expression),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || '页面脚本执行失败');
    return result?.value;
  }

  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return data || '';
  }

  async closePage() {
    try { await this.connection.send('Target.closeTarget', { targetId: this.targetId }); } catch {}
  }
}

/**
 * Find the sidebar browser guest and attach to it.
 * `hintUrl` is the URL the panel reports; matching it avoids driving another tab
 * (including the DSH UI page itself, which is also an http:// target).
 */
export async function attachBrowserGuest(port, hintUrl, options = {}) {
  const endpoint = await probeCdp(port);
  if (!endpoint) return null;
  const connection = new CdpConnection(endpoint.webSocketDebuggerUrl);
  await connection.open();
  const { targetInfos } = await connection.send('Target.getTargets');
  const normalize = (value) => String(value || '').split('#')[0].replace(/\/+$/, '').toLowerCase();
  const hint = normalize(hintUrl);
  const usable = (targetInfos || []).filter((target) => {
    if (!target.url || target.url === 'about:blank') return false;
    if (target.type !== 'webview' && target.type !== 'page') return false;
    return /^https?:/i.test(target.url);
  });
  const isLocal = (target) => {
    try {
      const url = new URL(target.url);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    } catch { return false; }
  };
  let preferred = null;
  if (hint) preferred = usable.find((target) => normalize(target.url) === hint) || null;
  // The harness UI itself is served from localhost; only attach to a local target when the
  // caller explicitly asked for that URL (browser_serve pages), otherwise pick the real site.
  if (!preferred) preferred = usable.find((target) => !isLocal(target) && target.type === 'webview') || null;
  if (!preferred) preferred = usable.find((target) => !isLocal(target)) || null;
  if (!preferred) preferred = usable[usable.length - 1] || null;
  if (!preferred) {
    connection.close();
    return null;
  }
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId: preferred.targetId, flatten: true });
  const session = new CdpSession(connection, sessionId, preferred.targetId, options);
  await session.init();
  return { connection, session, endpoint, target: preferred };
}
