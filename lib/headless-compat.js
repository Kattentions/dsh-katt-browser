/**
 * Compatibility layer for the legacy headless driver.
 *
 * `BrowserSession` predates the hybrid driver and only implements the core
 * navigations the old screencast panel needed. Every newer tool call
 * (pageText, waitFor, clickLocated, listTabs, pageTables, ...) would hit a
 * missing method and throw `TypeError: browser.x is not a function`, which made
 * `driver: headless` look broken the moment a second tool was used.
 *
 * This adapter fills in the gaps on the instance itself: the methods that can be
 * expressed with what the class already exposes (Runtime.evaluate, Input
 * dispatch) are implemented properly, and the ones that genuinely need the
 * webview panel return an explicit, actionable error instead of crashing.
 *
 * @param {object} instance - one BrowserSession instance.
 * @param {object} config - the live plugin config.
 * @returns {object} the same instance, augmented in place.
 */
export function adaptHeadless(instance, config = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const unsupported = (feature) => async () => ({
    error: 'headless 驱动不支持' + feature + '；需要这个能力请把 katt-browser 的 driver 切回 webview。',
  });
  const evaluate = async (expression) => instance.evaluate(expression);

  /* ---- diagnostics the Host/tools read ---- */
  if (typeof instance.guardSession !== 'function') {
    instance.guardSession = async () => null;
  }
  if (!Object.prototype.hasOwnProperty.call(instance, 'diagnostics')) {
    try {
      Object.defineProperty(instance, 'diagnostics', {
        configurable: true,
        get: () => ({ mode: 'headless', target: instance.state.url || null, zoomFactor: 1, port: 0 }),
      });
    } catch (error) { /* frozen instance */ }
  }
  if (typeof instance.refreshProbe !== 'function') {
    instance.refreshProbe = async () => {
      instance.probe = {
        at: Date.now(),
        hasWebview: false,
        headless: true,
        state: instance.state,
        v: 'headless',
      };
      return instance.probe;
    };
  }
  if (typeof instance.barriers !== 'function') {
    /* The tools attach this field to every open result; returning undefined would
       make the tool result non-JSON and fail output validation. */
    instance.barriers = async () => ({ checked: false, headless: true, note: 'headless 驱动不做登录/验证码栏位检查' });
  }
  if (typeof instance.pageDiagnostics !== 'function') {
    instance.pageDiagnostics = async () => ({
      headless: true,
      note: '页面渲染诊断需要 webview 驱动（headless 没有可观察的面板）',
      state: instance.state,
    });
  }

  /* ---- page reading ---- */
  if (typeof instance.pageText !== 'function') {
    instance.pageText = async (maxChars = 4000) => {
      const text = await evaluate(
        '(() => { const body = document.body; const text = body ? String(body.innerText || "") : ""; return { url: location.href, title: document.title, text }; })()',
      );
      const limit = Math.max(0, Number(maxChars) || 4000);
      return {
        url: text && text.url ? text.url : instance.state.url,
        title: text && text.title ? text.title : instance.state.title,
        text: String((text && text.text) || '').slice(0, limit),
      };
    };
  }
  if (typeof instance.pageMarkdown !== 'function') {
    instance.pageMarkdown = async (maxChars = 6000) => {
      const page = await instance.pageText(maxChars);
      return { ...page, markdown: page.text };
    };
  }
  if (typeof instance.pageTables !== 'function') {
    instance.pageTables = async (maxTables = 3, maxRows = 30) => {
      const spec = JSON.stringify({ maxTables: Number(maxTables) || 3, maxRows: Number(maxRows) || 30 });
      const tables = await evaluate(`(() => {
        const { maxTables, maxRows } = ${spec};
        return [...document.querySelectorAll('table')].slice(0, maxTables).map((table) => ({
          headers: [...table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')].map((cell) => String(cell.innerText || '').trim()),
          rows: [...table.querySelectorAll('tbody tr, tr')].slice(0, maxRows).map((row) => [...row.querySelectorAll('td, th')].map((cell) => String(cell.innerText || '').trim())),
        }));
      })()`);
      return { tables: Array.isArray(tables) ? tables : [] };
    };
  }
  if (typeof instance.waitFor !== 'function') {
    instance.waitFor = async (wanted = {}) => {
      const total = Math.min(60000, Math.max(300, Number(wanted.timeoutMs) || 8000));
      const spec = JSON.stringify({
        selector: String(wanted.selector || ''),
        url: String(wanted.url || ''),
        text: String(wanted.text || ''),
      });
      const probe = `(() => {
        const want = ${spec};
        if (want.selector) {
          const el = document.querySelector(want.selector);
          if (!el) return JSON.stringify({ ok: false, reason: 'selector' });
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return JSON.stringify({ ok: false, reason: 'not-visible' });
        }
        if (want.text && !(document.body && String(document.body.innerText).includes(want.text))) {
          return JSON.stringify({ ok: false, reason: 'text' });
        }
        if (want.url) {
          let current = String(location.href).split('#')[0];
          while (current.endsWith('/')) current = current.slice(0, -1);
          let target = want.url;
          while (target.endsWith('/')) target = target.slice(0, -1);
          if (!current.startsWith(target)) return JSON.stringify({ ok: false, reason: 'url' });
        }
        return JSON.stringify({ ok: true, url: location.href });
      })()`;
      const started = Date.now();
      let last = { ok: false, reason: 'not-started' };
      while (Date.now() - started <= total) {
        try {
          const raw = await evaluate(probe);
          last = raw ? JSON.parse(raw) : { ok: false, reason: 'empty' };
          if (last.ok) return { ok: true, waitedMs: Date.now() - started, waited: true, url: last.url };
          await sleep(250);
        } catch (error) {
          return { ok: false, timedOut: false, waitedMs: Date.now() - started, error: String(error && error.message ? error.message : error) };
        }
      }
      return { ok: false, timedOut: true, waitedMs: Date.now() - started, reason: last.reason, waited: false };
    };
  }

  /* ---- interaction ---- */
  if (typeof instance.clickLocated !== 'function') {
    instance.clickLocated = async (target = {}) => {
      const spec = JSON.stringify({ selector: String(target.selector || ''), text: String(target.text || '') });
      const found = await evaluate(`(() => {
        const want = ${spec};
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && Number(style.opacity) !== 0;
        };
        let el = null;
        let mode = '';
        if (want.selector) { el = document.querySelector(want.selector); mode = 'selector'; }
        if (!el && want.text) {
          const needle = want.text;
          el = [...document.querySelectorAll('button,a,[role="button"],[role="link"],input,label,li,span,div')]
            .find((node) => node.children.length <= 3 && visible(node) && String(node.innerText || node.value || '').trim().includes(needle)) || null;
          mode = 'text';
        }
        if (!el || !visible(el)) return { ok: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { ok: true, mode, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!found || !found.ok) return { ok: false, error: '没找到可点击的元素' };
      await instance.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y }, instance.sessionId);
      await instance.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 }, instance.sessionId);
      await instance.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 }, instance.sessionId);
      await sleep(150);
      return { ok: true, mode: found.mode, x: found.x, y: found.y };
    };
  }
  if (typeof instance.hoverAt !== 'function') {
    instance.hoverAt = async (x, y) => {
      await instance.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(x), y: Number(y) }, instance.sessionId);
      return { ok: true, x: Number(x), y: Number(y) };
    };
  }
  if (typeof instance.zoom !== 'function') {
    instance.zoom = async (action = 'in', factor) => {
      const next = await evaluate(`(() => {
        const previous = Number(document.documentElement.style.zoom || 1) || 1;
        const action = ${JSON.stringify(String(action))};
        const wanted = Number(${JSON.stringify(Number(factor) || 0)});
        const value = action === 'reset' ? 1 : action === 'set' ? (wanted || 1) : previous + (action === 'out' ? -0.1 : 0.1);
        const clamped = Math.min(5, Math.max(0.25, Number(value.toFixed(2))));
        document.documentElement.style.zoom = String(clamped);
        return clamped;
      })()`);
      return { ok: true, zoomFactor: next };
    };
  }

  /* ---- tabs: the headless driver has exactly one page ---- */
  if (typeof instance.listTabs !== 'function') {
    instance.listTabs = async () => ({
      tabs: [
        {
          tabId: 'headless',
          sessionId: '',
          visible: false,
          title: instance.state.title || '',
          url: instance.state.url || '',
          remembered: false,
        },
      ],
      keep: [],
      closed: 0,
      remaining: 1,
      queued: [],
      replays: [],
      note: 'headless 驱动只有一个页面',
    });
  }
  if (typeof instance.cancelQueued !== 'function') {
    /* The headless driver keeps no queue: every open goes straight to its page. */
    instance.cancelQueued = async () => ({ ok: true, remaining: 0, note: 'headless 驱动没有排队页' });
  }
  if (typeof instance.tabSwitch !== 'function') {
    instance.tabSwitch = async () => ({ ok: true, note: 'headless 驱动只有一个页面' });
  }
  if (typeof instance.tabNew !== 'function') {
    instance.tabNew = async (url) => {
      if (url) await instance.navigate(String(url));
      return { ok: true, tabId: 'headless', url: instance.state.url };
    };
  }
  if (typeof instance.tabClose === 'function') {
    /* keep the class implementation when it exists */
  } else {
    instance.tabClose = async () => ({ error: 'headless 驱动只有一个页面，无法关闭标签页；可以直接切换 driver 或让实例空闲回收。' });
  }

  /* ---- records / cookies / files: webview-only capabilities ---- */
  if (typeof instance.consoleLogs !== 'function') {
    instance.consoleLogs = async () => ({ total: 0, count: 0, entries: [], note: 'headless 驱动不采集 console，请用 webview 驱动' });
  }
  if (typeof instance.networkLogs !== 'function') {
    instance.networkLogs = async () => ({ total: 0, count: 0, entries: [], note: 'headless 驱动不采集网络历史，请用 webview 驱动' });
  }
  if (typeof instance.instrumentData !== 'function') {
    instance.instrumentData = async () => ({ workers: [], messages: [], note: 'headless 驱动不做页面插桩，请用 webview 驱动' });
  }
  if (typeof instance.clearDiagnostics !== 'function') {
    instance.clearDiagnostics = async () => ({ ok: true, note: 'headless 驱动没有可清理的诊断记录' });
  }
  if (typeof instance.clearHistory !== 'function') {
    instance.clearHistory = async () => ({ ok: true, note: 'headless 驱动没有工具操作历史' });
  }
  if (typeof instance.actionHistory !== 'function') {
    instance.actionHistory = async () => ({ entries: [] });
  }
  instance.cookiesAction = instance.cookiesAction || unsupported('Cookie 快照');
  instance.profiles = instance.profiles || (async () => ({ profiles: [], note: 'headless 每会话独立 profile，不支持命名快照' }));
  instance.download = instance.download || unsupported('页面内下载');
  instance.setFiles = instance.setFiles || unsupported('文件上传');

  return instance;
}
