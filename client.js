window.__ModuleLoader__.load({
  id: '@local/katt-browser',
  factory(require) {
    let React = null;
    try { React = require('react'); } catch (error) { React = null; }
    const h = React ? React.createElement : null;

    /* ------------------------------------------------------------------------
       katt-browser client half (webview driver).

       The panel is the shipped right-sidebar Browser tab: a native Electron
       <webview> guest. This plugin does not render anything itself; it forwards
       commands from the Host tools to that guest through the webview element API
       and reports the guest's state back. No screenshots are streamed, so the
       panel renders at native speed and costs no extra CPU or memory.
    ------------------------------------------------------------------------ */

    const RESULT_URL = '/api/katt-browser/result';
    const PAGE_STATE_URL = '/api/katt-browser/page-state';
    const PROBE_URL = '/api/katt-browser/probe';
    const PULL_URL = '/api/katt-browser/pull';
    const HELLO_URL = '/api/katt-browser/client-hello';
    const OPEN_FILE_URL = '/api/katt-browser/open-file';
    const VERSION = '0.9.65';
    /* The phone GUI uses the same client bundle but cannot own an Electron
       <webview>; it must never poll commands or overwrite the desktop's state. */
    const canHostPanel = (() => { try { return Boolean(globalThis.dshDesktop && globalThis.dshDesktop.browser); } catch (error) { return false; } })();


    const ORIGINS = [''];
    try {
      const injected = window.__KATT_BROWSER_ORIGIN__;
      if (typeof injected === 'string' && injected && ORIGINS.indexOf(injected) < 0) ORIGINS.push(injected);
    } catch {}
    try {
      const transport = window.__DSH_TRANSPORT__;
      const streamBase = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl.replace(/\/+$/, '') : '';
      if (streamBase && ORIGINS.indexOf(streamBase) < 0) ORIGINS.push(streamBase);
    } catch {}
    let originIndex = 0;
    const apiBase = () => ORIGINS[originIndex] || '';
    const bridgeGeneration = typeof window !== 'undefined'
      ? (window.__KATT_BRIDGE_GEN__ = (Number(window.__KATT_BRIDGE_GEN__) || 0) + 1)
      : 1;

    let pluginCtx = null;
    /* Opens requested while the caller session pane was not visible; replayed when
       the user switches to that session. */
    const pendingOpens = new Map();
    /* Recent replay attempts, for diagnosing the switch-back flow from the Host. */
    const replayLog = [];
    /* Hidden tabs have no mounted webview, so the panel cannot report their URL/title.
       Remember what each tab last showed while it was mounted. */
    const tabMemory = new Map();
    /* Tab ids are only unique inside one session's panel, so every internal table
       keys tabs by session + id. */
    const tabKeyOf = (tab) => String((tab && tab.sessionId) || '') + '|' + String((tab && tab.tabId) || '');
    /* Default page for a browser tab opened without a URL ("浏览器" command / Ctrl+T).
       The Host sends the configured value back with every probe reply. */
    let homeUrl = 'https://www.bing.com';
    let driverMode = 'webview';
    let restoreLastPage = true;
    let lastPages = {};
    let sessionTitles = {};
    let sessionMeta = {};
    /* "会话标题 · 工作区名" for settings rows; falls back to the raw id. */
    const sessionLabel = (id) => {
      try {
        const meta = sessionMeta[id] || {};
        const title = String(meta.title || sessionTitles[id] || '').trim();
        const cwd = String(meta.cwd || '');
        const workspace = cwd === '' ? '' : String(cwd).split(/[\\/]/).filter(Boolean).pop() || '';
        return [title, workspace].filter(Boolean).join(' · ');
      } catch (error) { return ''; }
    };
    let postedEmptyState = false;
    let maxHeadlessBrowsers = 3;
    let headlessInstances = 0;
    let pageStateTimer = null;
    let replayTimer = null;
    // Revealing the sidebar is opt-in: the panel belongs to whichever session the user is
    // viewing, and a tool call from another workspace must not open it in front of them.
    let revealPanel = false;

    const sidebarRight = () => {
      try {
        if (!pluginCtx) return null;
        return (typeof pluginCtx.get === 'function' && pluginCtx.get('sidebarRight')) || null;
      } catch { return null; }
    };

    /**
     * The right sidebar is per-session. This attribute is the shell's own marker for
     * "the session whose right pane is mounted right now"; tool calls carry the
     * session that invoked them, and a mismatch means the panel belongs to somebody
     * else's conversation. Never drive it in that case.
     */
    function visibleSession() {
      try {
        /* Several sessions' right seats can be mounted at once; the hidden ones are
           display:none / zero-sized. The one the user is actually looking at is the
           displayed seat, so pick that instead of the first node in DOM order. */
        const nodes = [...document.querySelectorAll('[data-sidebar-right-session]')];
        let best = '';
        let bestArea = 0;
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (rect.width <= 0 || rect.height <= 0) continue;
          const area = rect.width * rect.height;
          if (area > bestArea) { bestArea = area; best = String(node.getAttribute('data-sidebar-right-session') || ''); }
        }
        return best;
      } catch { return ''; }
    }

    /** Session that owns the panel a given webview belongs to. */
    function ownerSession(view) {
      try {
        const host = view && view.closest ? view.closest('[data-sidebar-right-session]') : null;
        return host ? String(host.getAttribute('data-sidebar-right-session') || '') : '';
      } catch { return ''; }
    }

    const layout = () => {
      try {
        if (!pluginCtx) return null;
        return (typeof pluginCtx.get === 'function' && pluginCtx.get('layout')) || null;
      } catch { return null; }
    };

    function expandRightbar() {
      if (!revealPanel) return;
      // Expanding the right column matters: a collapsed sidebar can hold the tab
      // without mounting its pane, and the native <webview> only exists once mounted.
      const layoutService = layout();
      if (layoutService && typeof layoutService.openRightbar === 'function') {
        try { layoutService.openRightbar(true, false); } catch {}
      }
    }

    function post(url, body) {
      return fetch(apiBase() + url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((response) => response.json().catch(() => null)).catch(() => null);
    }

    /* ----------------------------------------------------------- webview guest */


    function tabIdOf(element) {
      let node = element;
      for (let depth = 0; depth < 10 && node; depth += 1) {
        if (node.dataset && node.dataset.sidebarRightTab) return node.dataset.sidebarRightTab;
        node = node.parentElement;
      }
      return '';
    }

    function tabChip(tabId) {
      if (!tabId) return null;
      try { return document.querySelector(`[data-dockkit-tab="${tabId}"]`); } catch { return null; }
    }

    async function activateTab(tabId) {
      const chip = tabChip(tabId);
      if (!chip) return false;
      if (chip.getAttribute('aria-selected') === 'true') return true;
      try { chip.click(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 350));
      return true;
    }

    function measure(element) {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function findWebview(session) {
      try {
        /* With a session in hand only that session's own browser tab is a valid
           target: the other seats in this document belong to conversations the user
           may be watching. */
        const all = [...document.querySelectorAll('webview')].filter((element) => !session || ownerSession(element) === session);
        if (all.length === 0) return null;
        // Several browser tabs can be open; only the visible one can receive input.
        let best = null;
        let bestArea = 0;
        for (const element of all) {
          const area = measure(element);
          if (area <= 4) continue;
          const style = window.getComputedStyle(element);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
          if (area > bestArea) { best = element; bestArea = area; }
        }
        return best || all[0] || null;
      } catch { return null; }
    }

    // A background tab keeps its <webview> in the DOM with a 0x0 box; activate its tab
    // chip first so the pane gets laid out and can receive input.
    async function ensureVisibleWebview(session) {
      let view = findWebview(session);
      if (!view) return null;
      if (measure(view) > 4) { installSameTabPolicy(view); return view; }
      const tabId = tabIdOf(view);
      // When revealPanel is off, keep the panel exactly as the user left it: the guest can
      // still be driven while hidden, it just is not the focused surface.
      if (!revealPanel) { installSameTabPolicy(view); return view; }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const layoutService = layout();
        if (layoutService && typeof layoutService.openRightbar === 'function') {
          try { layoutService.openRightbar(true, false); } catch {}
        }
        if (tabId) await activateTab(tabId);
        await new Promise((resolve) => setTimeout(resolve, 400));
        view = findWebview(session);
        if (view && measure(view) > 4) { installSameTabPolicy(view); return view; }
      }
      return view;
    }

    async function waitForWebview(timeoutMs = 10000, session = '') {
      const deadline = Date.now() + timeoutMs;
      let view = await ensureVisibleWebview(session);
      while (!view && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        view = await ensureVisibleWebview(session);
      }
      return view || null;
    }

    function capabilities(view) {
      const names = ['loadURL', 'getURL', 'getTitle', 'executeJavaScript', 'sendInputEvent', 'goBack', 'goForward', 'reload', 'capturePage', 'focus', 'stop', 'isLoading', 'setZoomFactor', 'getZoomFactor'];
      const out = {};
      for (const name of names) out[name] = typeof view[name] === 'function';
      out.tag = view.tagName;
      out.src = typeof view.getURL === 'function' ? (() => { try { return view.getURL(); } catch { return ''; } })() : '';
      return out;
    }

    // Links with target=_blank / window.open() normally open a new panel tab; the agent
    // (and the user browsing through it) expects in-place navigation with history, so
    // force every popup back into the current tab.
    const SAME_TAB_POLICY = `(() => {
      try {
        if (window.__kattSameTabPolicy) return 'already';
        window.__kattSameTabPolicy = true;
        const nativeOpen = window.open;
        window.open = function (url) {
          try { if (url) location.assign(String(url)); } catch {}
          void nativeOpen;
          return null;
        };
        document.addEventListener('click', (event) => {
          const target = event.target;
          const anchor = target && target.closest ? target.closest('a[target]') : null;
          if (anchor && anchor.target && anchor.target.toLowerCase() !== '_self') anchor.target = '_self';
        }, true);
        document.addEventListener('submit', (event) => {
          const form = event.target;
          if (form && form.target && form.target.toLowerCase() !== '_self') form.target = '_self';
        }, true);
        return 'installed';
      } catch { return 'failed'; }
    })()`;

    // The sidebar session denies every permission request, so navigator.clipboard.writeText
    // rejects even though execCommand('copy') reaches the OS clipboard. This copy has to be
    // installed from the renderer too: CDP may be detached while the user is just browsing.
    const CLIPBOARD_SHIM = `(() => {
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard || window.__kattClipboard) return 'already';
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
        return 'installed';
      } catch { return 'failed'; }
    })()`;

    function installSameTabPolicy(view) {
      try {
        if (view.__kattSameTabHooked) return;
        view.__kattSameTabHooked = true;
        for (const eventName of ['dom-ready', 'did-finish-load', 'did-navigate']) {
          try {
            view.addEventListener(eventName, () => {
              try { view.executeJavaScript(SAME_TAB_POLICY, true); } catch {}
              try { view.executeJavaScript(CLIPBOARD_SHIM, true); } catch {}
            });
          } catch {}
        }
      } catch {}
      try { view.executeJavaScript(SAME_TAB_POLICY, true); } catch {}
      try { view.executeJavaScript(CLIPBOARD_SHIM, true); } catch {}
    }

    function keyboardCode(name) {      const map = {
        Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
        Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
        Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        Home: { key: 'Home', code: 'Home', keyCode: 36 },
        End: { key: 'End', code: 'End', keyCode: 35 },
        PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
      };
      return map[name] || null;
    }

    // The same element enumeration the Host used to run over CDP, now executed inside
    // the guest. Refs are indices into this list.
    const ENUM_FN = `function kattList() {
      const nodes = [];
      const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
      const usable = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        return true;
      };
      for (const el of document.querySelectorAll(selector)) {
        if (usable(el)) nodes.push(el);
      }
      if (nodes.length >= 5) return nodes;
      /* Div-built pages (courses, admin consoles) have almost no native controls: the
         expand arrow is a div with cursor:pointer. Add anything that behaves like a
         control so the ref list is still actionable, keeping this one ordered list so
         click/type indices stay in sync with the snapshot. */
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        if (nodes.length >= 80) break;
        if (el.hasAttribute('role')) continue;
        const tag = el.tagName;
        if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY' || tag === 'OPTION') continue;
        if (!usable(el)) continue;
        const style = window.getComputedStyle(el);
        const clickable = style.cursor === 'pointer' || typeof el.onclick === 'function'
          || el.hasAttribute('onclick') || el.hasAttribute('aria-expanded')
          || el.hasAttribute('tabindex') || el.hasAttribute('data-action');
        if (!clickable) continue;
        if (!kattLabel(el)) continue;
        nodes.push(el);
      }
      return nodes;
    }
    function kattLabel(el) {
      const raw = el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
      return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 90);
    }`;

    async function guestEval(view, code) {
      if (typeof view.executeJavaScript !== 'function') throw new Error('webview 不支持 executeJavaScript');
      return view.executeJavaScript(code, true);
    }

    async function guestSnapshot(view) {
      const script = `(() => { ${ENUM_FN}
        const els = kattList();
        const total = els.length;
        const capped = els.slice(0, 200);
        return {
          elements: capped.map((el, index) => {
            const rect = el.getBoundingClientRect();
            return {
              ref: index + 1,
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              label: kattLabel(el),
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2),
              inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
            };
          }),
          total,
          text: document.body ? document.body.innerText.slice(0, 3000) : '',
          url: location.href,
          title: document.title,
        };
      })()`;
      return guestEval(view, script);
    }

    async function guestElementCenter(view, ref) {
      const script = `(() => { ${ENUM_FN}
        const el = kattList()[${Number(ref) - 1}];
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase(), label: kattLabel(el) };
      })()`;
      return guestEval(view, script);
    }

    function sendInput(view, event) {
      if (typeof view.sendInputEvent !== 'function') return false;
      try { view.sendInputEvent(event); return true; } catch { return false; }
    }

    function guestSize(view) {
      const rect = view.getBoundingClientRect();
      return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    }

    async function doClick(view, args) {
      const ref = Number(args && args.ref);
      const center = await guestElementCenter(view, ref);
      if (!center) throw new Error('ref e' + ref + ' 不存在，请重新 snapshot');
      const used = sendInput(view, { type: 'mouseDown', x: Math.round(center.x), y: Math.round(center.y), button: 'left', clickCount: 1 })
        && sendInput(view, { type: 'mouseUp', x: Math.round(center.x), y: Math.round(center.y), button: 'left', clickCount: 1 });
      if (!used) {
        // Fallback for builds without sendInputEvent: a scripted click.
        await guestEval(view, `(() => { ${ENUM_FN} const el = kattList()[${ref - 1}]; if (el) el.click(); })()`);
      }
      return { ok: true, ref, x: Math.round(center.x), y: Math.round(center.y), realInput: used };
    }

    async function doType(view, args) {
      const ref = Number(args && args.ref);
      const text = String((args && args.text) || '');
      const clear = Boolean(args && args.clear);
      const submit = Boolean(args && args.submit);
      const center = await guestElementCenter(view, ref);
      if (!center) throw new Error('ref e' + ref + ' 不存在，请重新 snapshot');
      // execCommand('insertText') inserts the whole string once; per-character
      // sendInputEvent char events sometimes land twice in Electron webviews.
      const inserted = await guestEval(view, `(() => { ${ENUM_FN}
        const el = kattList()[${ref - 1}]; if (!el) return false;
        el.focus();
        if (${clear ? 'true' : 'false'}) {
          if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          else if (el.isContentEditable) { el.textContent = ''; }
        }
        if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, ${JSON.stringify(text)})) return true;
        if ('value' in el) { el.value = (el.value || '') + ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        if (el.isContentEditable) { el.textContent = (el.textContent || '') + ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        return false;
      })()`);
      if (!inserted) throw new Error('输入框没有接收文字（ref e' + ref + '）');
      if (submit) {
        sendInput(view, { type: 'keyDown', keyCode: 'Enter' });
        sendInput(view, { type: 'keyUp', keyCode: 'Enter' });
        // The guest's focused control may ignore synthetic keys; submit its form directly.
        await guestEval(view, `(() => {
          const el = document.activeElement;
          if (el && el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); return; }
          if (el && el.form) { el.form.submit(); return; }
          if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        })()`);
      }
      return { ok: true, ref, typed: text.length, mode: 'insertText' };
    }

    async function doPress(view, args) {
      const name = String((args && args.key) || '');
      const spec = keyboardCode(name);
      if (spec) {
        const ok = sendInput(view, { type: 'keyDown', keyCode: name }) && sendInput(view, { type: 'keyUp', keyCode: name });
        if (!ok) await guestEval(view, `(() => { const el = document.activeElement || document.body; el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(spec.key)}, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(spec.key)}, bubbles: true })); })()`);
        return { ok: true, key: name };
      }
      if (name.length === 1) {
        const ok = sendInput(view, { type: 'char', keyCode: name });
        if (!ok) await guestEval(view, `(() => { const el = document.activeElement; if (!el) return; if ('value' in el) el.value += ${JSON.stringify(name)}; else if (el.isContentEditable) el.textContent += ${JSON.stringify(name)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        return { ok: true, inserted: name };
      }
      throw new Error('不支持的按键: ' + name);
    }

    async function doScroll(view, args) {
      const deltaY = Number((args && args.deltaY) || 0);
      const size = guestSize(view);
      const before = Number(await guestEval(view, 'Math.round(window.scrollY) || 0')) || 0;
      sendInput(view, {
        type: 'mouseWheel',
        x: Math.round(size.width / 2),
        y: Math.round(size.height / 2),
        deltaX: 0,
        deltaY,
        wheelTicksX: 0,
        wheelTicksY: deltaY / 100,
        canScroll: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 160));
      const after = Number(await guestEval(view, 'Math.round(window.scrollY) || 0')) || 0;
      if (after === before) {
        // Synthetic wheel events are dropped by some pages; scroll the document directly.
        await guestEval(view, `(() => {
          const delta = ${Math.round(deltaY)};
          const target = document.scrollingElement || document.documentElement || document.body;
          if (target) target.scrollTop = (target.scrollTop || 0) + delta;
          if ((Math.round(window.scrollY) || 0) === ${before}) window.scrollBy(0, delta);
          return Math.round(window.scrollY) || 0;
        })()`);
      }
      return { ok: true, deltaY };
    }

    async function stateOf(view) {
      const read = (fn) => { try { return typeof view[fn] === 'function' ? view[fn]() : undefined; } catch { return undefined; } };
      const size = guestSize(view);
      return {
        url: read('getURL') || '',
        title: read('getTitle') || '',
        loading: read('isLoading') === true,
        canGoBack: read('canGoBack') === true,
        canGoForward: read('canGoForward') === true,
        viewport: size,
      };
    }

    /** One tab row for the Host tools and the settings page. */
    function describeBrowserTab(tab, visible) {
      const chip = tabChip(tab.tabId);
      const navigation = tab.navigation && tab.navigation.params ? tab.navigation.params : {};
      const memory = tabMemory.get(tabKeyOf(tab)) || null;
      const chipTitle = chip ? String(chip.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
      const navigationUrl = typeof navigation.url === 'string' ? navigation.url : '';
      return {
        tabId: tab.tabId,
        sessionId: tab.sessionId || '',
        visible: Boolean(tab.sessionId && visible && tab.sessionId === visible),
        title: chipTitle || (memory && memory.title ? memory.title.slice(0, 60) : ''),
        url: navigationUrl || (memory && memory.url ? memory.url.slice(0, 200) : ''),
        remembered: Boolean(!chipTitle && !navigationUrl && memory),
      };
    }

    function resolveTab(args) {
      const tabId = String((args && args.tabId) || '');
      const sessionId = String((args && args.sessionId) || '');
      const tabs = browserTabs().filter((item) => item.tabId === tabId && (sessionId === '' || item.sessionId === sessionId));
      if (tabs.length === 0) return { error: '找不到标签：' + tabId + (sessionId === '' ? '' : '（会话 ' + sessionId.slice(0, 12) + '）') };
      if (tabs.length > 1) return { error: '多个会话有同名标签 ' + tabId + '，请带 sessionId 指定（候选：' + tabs.map((item) => String(item.sessionId || '').slice(0, 12)).join(', ') + '）' };
      return { tab: tabs[0] };
    }

    function browserTabs() {
      try {
        const right = sidebarRight();
        if (!right || !right.openTabs || typeof right.openTabs.getSnapshot !== 'function') return [];
        return right.openTabs.getSnapshot().filter((tab) => tab.kind === 'browser');
      } catch { return []; }
    }

    // The shipped panel only creates its <webview> once a page target exists, so the
    // first navigation has to go through the panel's own address bar.
    async function navigateViaPanelUi(url) {
      const inputs = [...document.querySelectorAll('input')].filter((el) => {
        const placeholder = String(el.getAttribute('placeholder') || '');
        return /HTTP|地址|address/i.test(placeholder);
      });
      const input = inputs[0];
      if (!input) return false;
      try {
        input.focus();
        // React's controlled input sometimes swallows synthetic input events; calling the
        // element's own React props is the dependable way to submit the panel's form.
        const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
        const props = propsKey ? input[propsKey] : null;
        if (props && typeof props.onChange === 'function') {
          props.onChange({ target: { value: url }, currentTarget: { value: url } });
        } else {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, url);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (props && typeof props.onKeyDown === 'function') {
          props.onKeyDown({ key: 'Enter', code: 'Enter', preventDefault() {}, stopPropagation() {}, target: input, currentTarget: input, nativeEvent: { key: 'Enter' } });
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
        return true;
      } catch {
        return false;
      }
    }

    /**
     * "浏览器" (Ctrl+T) opens an empty browser tab on the guide screen: no webview,
     * just an address box. Fill the configured home in two ways: inject params.url
     * into openTab calls, and as a fallback submit the guide tab's address box.
     */
    /** Where a fresh browser tab should go: the owning session's last page. */
    function defaultPage(session) {
      const owner = String(session || '') || visibleSession();
      if (restoreLastPage) {
        try {
          const saved = lastPages[owner];
          if (typeof saved === 'string' && saved !== '') return saved;
        } catch (error) { /* fall back to home */ }
      }
      return homeUrl;
    }

    function installHomeTabDefault() {
      try {
        const right = pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('sidebarRight') : null;
        if (right && typeof right.openTab === 'function' && !right.__kattHomeDefault) {
          right.__kattHomeDefault = true;
          const original = right.openTab;
          right.openTab = function (kind, options) {
            if (kind !== 'browser') return original.call(this, kind, options);
            const next = options && typeof options === 'object' ? { ...options } : {};
            const params = next.params && typeof next.params === 'object' ? { ...next.params } : {};
            if (typeof params.url !== 'string' || params.url.trim() === '') params.url = defaultPage();
            next.params = params;
            return original.call(this, kind, next);
          };
        }
      } catch (error) { /* service not available yet */ }

      if (typeof window === 'undefined' || window.__kattGuideTabHome) return;
      window.__kattGuideTabHome = true;
      const seen = new WeakSet();
      const submit = (input, props, session) => {
        try {
          if (!input.isConnected) return;
          input.focus();
          const target = defaultPage(session);
          if (props && typeof props.onChange === 'function') {
            props.onChange({ target: { value: target }, currentTarget: { value: target } });
          } else {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, target);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          setTimeout(() => {
            try {
              /* The address box submits through its own 前往 button; a synthetic Enter
                 keypress does not reach that form in every shell build. */
              const box = input.parentElement;
              const go = box && box.querySelector('button.addressGo, button[aria-label="前往"], button[aria-label="Go"], button[type="submit"]');
              if (go) { go.click(); return; }
            } catch (error) { /* gone */ }
            try {
              if (props && typeof props.onKeyDown === 'function') {
                props.onKeyDown({ key: 'Enter', code: 'Enter', preventDefault() {}, stopPropagation() {}, target: input, currentTarget: input, nativeEvent: { key: 'Enter' } });
              } else {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
              }
            } catch (error) { /* gone */ }
          }, 120);
        } catch (error) { /* gone */ }
      };
      const fill = (tab) => {
        if (seen.has(tab)) return;
        /* Only the guide state has no guest yet; a loaded tab already owns a webview. */
        if (tab.querySelector('webview')) return;
        /* A guide tab can belong to a hidden session; fill it with that session's
           last page, never with the page of the session the user is watching. */
        const owner = ownerSession(tab) || visibleSession();
        const input = tab.querySelector('input');
        if (!input) return;
        const placeholder = String(input.getAttribute('placeholder') || '');
        if (!/HTTP|地址|address/i.test(placeholder)) return;
        seen.add(tab);
        const propsKey = Object.keys(input).find((key) => key.indexOf('__reactProps') === 0);
        const props = propsKey ? input[propsKey] : null;
        setTimeout(() => submit(input, props, owner), 800);
      };
      const scan = () => { for (const tab of document.querySelectorAll('[data-sidebar-right-tab]')) fill(tab); };
      try { new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true }); } catch (error) { /* no observer */ }
      scan();
    }

    /**
     * Omnibox: a value with a scheme or a host-like shape is a URL; anything else is
     * a search on the configured home's engine (Bing). Mirrors how Edge treats the
     * address bar, so typing "bing" searches instead of failing to resolve a host.
     */
    function resolveAddress(raw) {
      const text = String(raw || '').trim();
      if (text === '') return text;
      if (/^[a-z][a-z\d+.-]*:/i.test(text)) return text;
      if (text.startsWith('//')) return 'https:' + text;
      const hostPort = /^(?:localhost|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z\d-]+(?:\.[a-z\d-]+)+)(?::\d+)?(?:[/?#].*)?$/i;
      if (!/\s/.test(text) && hostPort.test(text)) return 'https://' + text;
      return 'https://www.bing.com/search?q=' + encodeURIComponent(text);
    }

    function installOmniboxSearch() {
      if (typeof window === 'undefined' || window.__kattOmniboxSearch) return;
      window.__kattOmniboxSearch = true;
      const isAddressInput = (el) => {
        if (!el || el.tagName !== 'INPUT') return false;
        return /HTTP|地址|address/i.test(String(el.getAttribute('placeholder') || '') + ' ' + String(el.getAttribute('aria-label') || ''));
      };
      const boxOf = (el) => (el && el.closest ? (el.closest('[class*="addressBox"]') || el.closest('form')) : null);
      const setValue = (input, value) => {
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        } catch (error) { return false; }
      };
      const submit = (input) => {
        const box = boxOf(input);
        const go = box && box.querySelector('button[type="submit"], button[class*="addressGo"], button[aria-label="前往"], button[aria-label="Go"]');
        setTimeout(() => { if (go && go.isConnected) { try { go.click(); } catch (error) { /* gone */ } } }, 60);
      };
      /* Enter inside the address bar: rewrite a search term before the built-in parser
         turns it into a bogus hostname. */
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || !isAddressInput(event.target)) return;
        const raw = String(event.target.value || '');
        const next = resolveAddress(raw);
        if (next === raw.trim()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (setValue(event.target, next)) submit(event.target);
      }, true);
      /* The 前往 button reads the same value; intercept it too. */
      document.addEventListener('click', (event) => {
        const target = event.target;
        const go = target && target.closest ? target.closest('button[type="submit"], button[class*="addressGo"], button[aria-label="前往"], button[aria-label="Go"]') : null;
        if (!go) return;
        const box = go.closest('[class*="addressBox"]') || go.closest('form');
        const input = box && box.querySelector('input');
        if (!isAddressInput(input)) return;
        const raw = String(input.value || '');
        const next = resolveAddress(raw);
        if (next === raw.trim()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (setValue(input, next)) submit(input);
      }, true);
    }

    async function ensurePanelTab() {
      // Do not create an empty tab here: the bootstrap below opens one tab that already
      // carries the target URL, otherwise every first open would leave an extra empty tab.
      expandRightbar();
    }

    let cleanedTabs = false;
    // Bootstrapping and hot reloads leave empty "浏览器" tabs behind; keep the tab that
    // owns the live guest and close the empty leftovers once per page load.
    async function cleanupEmptyTabs(view) {
      if (cleanedTabs || !view) return;
      cleanedTabs = true;
      const right = sidebarRight();
      const keep = tabIdOf(view);
      /* Same rule as the explicit sweep: only blank start-page tabs of the session
         that owns this view. Other sessions mount no webview while hidden, and
         their tabs are not dead just because of that. */
      const scope = ownerSession(view) || visibleSession();
      const tabs = browserTabs();
      for (const tab of tabs) {
        if (tab.tabId === keep) continue;
        if (!tab.sessionId || tab.sessionId !== scope) continue;
        // A browser tab that still shows its start page title has no page in it; only
        // those are swept, so a tab with a loaded page is never closed behind the user.
        const chip = tabChip(tab.tabId);
        const label = chip ? String(chip.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (label !== '浏览器' && label !== 'Browser') continue;
        if (right && tab.sessionId && typeof right.closeIn === 'function') {
          try { right.closeIn(tab.sessionId, tab.tabId); } catch {}
        } else if (chip) {
          const closer = chip.querySelector('[aria-label*="关闭"], [aria-label*="Close"]');
          if (closer) { try { closer.click(); } catch {} }
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }

    async function runCommand(op, args) {

      /* Drop a queued page: with a session id only that entry, without one the
         whole queue. */
      if (op === 'cancel-queued') {
        const target = args && typeof args.session === 'string' ? args.session : '';
        if (target !== '') pendingOpens.delete(target);
        else pendingOpens.clear();
        return { ok: true, remaining: pendingOpens.size };
      }
      /* Open another tab's page in the current session's panel. */
      if (op === 'open-here') {
        const tabId = String((args && args.tabId) || '');
        const resolvedTab = tabId ? resolveTab(args) : { tab: null };
        if (resolvedTab.error) return { error: resolvedTab.error };
        const tab = resolvedTab.tab || null;
        const memory = tab ? tabMemory.get(tabKeyOf(tab)) || null : null;
        const navigation = tab && tab.navigation && tab.navigation.params ? tab.navigation.params : {};
        const url = String((args && args.url) || '') || (typeof navigation.url === 'string' ? navigation.url : '') || (memory && memory.url ? memory.url : '');
        if (!url) return { error: '这个标签页没有可用的 URL（可能还没被看到过）' };
        const session = visibleSession();
        if (!session) return { ok: false, error: '没有可见会话，无法在这里打开', url };
        /* Reuse the real open path: it bootstraps the panel, waits for the guest and
           retries loadURL, which a bare openTab + loadURL race gets wrong. */
        const opened = await runCommand('open', { url, session });
        if (opened && opened.error) return { ok: false, error: opened.error, url, session };
        return { ok: true, tabId, url, session, state: opened && opened.state ? opened.state : null };
      }
      /* Queue first: arrives when the caller's own pane is not the visible one. */
      if (op === 'queueOpen') {
        const session = args && typeof args.session === 'string' ? args.session : visibleSession();
        const url = String((args && args.url) || '').trim();
        if (session && url) pendingOpens.set(session, { url, at: Date.now() });
        return { ok: true, queued: Boolean(session && url), session };
      }
      const callerSession = args && typeof args.session === 'string' ? args.session : '';
      const currentSession = visibleSession();
      const mismatched = callerSession !== '' && currentSession !== '' && callerSession !== currentSession;
      const callerOwnsView = callerSession !== '' && [...document.querySelectorAll('webview')].some((view) => ownerSession(view) === callerSession);
      const opensPage = op === 'open' || op === 'navigate';
      /* Tab management and diagnostics are cross-session by design; every op that
         drives a page still needs the caller's own mounted tab. */
      const crossSessionOps = ['tabs', 'tab-close', 'sweep', 'probe', 'page-state'];
      if (mismatched && !callerOwnsView && !crossSessionOps.includes(op)) {
        if (opensPage) {
          /* The page belongs to a session whose pane is not mounted here. Keep it
             queued for that session instead of driving the panel the user is
             looking at; the heartbeat replays it when they switch over. */
          const requested = resolveAddress(String((args && args.url) || ''));
          if (requested) pendingOpens.set(callerSession, { url: requested, at: Date.now() });
          return {
            error: 'inactive-session',
            queued: Boolean(requested),
            requestedSession: callerSession,
            visibleSession: currentSession,
            hint: '这个会话的右侧栏现在不可见，页面已排队，切回该会话时会自动打开。',
          };
        }
        return {
          error: 'inactive-session',
          requestedSession: callerSession,
          visibleSession: currentSession,
          hint: '侧栏浏览器现在属于另一个会话，工具没有动它。切回发起工具的这个会话来用，或者把 katt-browser 的 driver 换成 headless。',
        };
      }
      if (op === 'open' || op === 'navigate') {
        const url = String((args && args.url) || '');
        const target = resolveAddress(url);
        await ensurePanelTab();
        let view = await waitForWebview(1500, callerSession);
        let uiDrove = null;
        if (!view) {
          const right = sidebarRight();
          /* Background sessions own no mounted tab yet: open the tab inside that
             session directly, so the page loads while the user is elsewhere and is
             already there when they switch back. */
          if (callerSession && right && typeof right.openTabIn === 'function') {
            try { right.openTabIn(callerSession, 'browser', { params: { url: target }, revealIfOpened: false }); } catch (error) { /* fall through */ }
            view = await waitForWebview(15000, callerSession);
          }
          /* Opening in the ACTIVE session is only acceptable when that is the caller's
             own session; otherwise it would flash a tab in someone else's panel. */
          if (!view && right && typeof right.openTab === 'function' && (!callerSession || callerSession === visibleSession())) {
            // Opening a tab with a url parameter makes the shipped panel create its
            // webview and navigate; only used when the session has no pane to target.
            const before = new Set(browserTabs().map((tab) => tab.tabId));
            try { right.openTab('browser', { params: { url: target } }); } catch (error) { uiDrove = 'openTab: ' + String(error && error.message ? error.message : error); }
            if (callerSession) {
              await new Promise((resolve) => setTimeout(resolve, 120));
              const created = browserTabs().filter((tab) => !before.has(tab.tabId));
              const wrong = created.filter((tab) => tab.sessionId && tab.sessionId !== callerSession);
              for (const tab of wrong) { try { right.closeIn(tab.sessionId, tab.tabId); } catch {} }
            }
          }
          view = await waitForWebview(15000, callerSession);
          /* Last resort: neither the session's pane nor openTabIn was available. */
          if (!view && callerSession && callerSession !== visibleSession()) {
            pendingOpens.set(callerSession, { url: target, at: Date.now() });
            return { error: 'inactive-session', queued: true, requestedSession: callerSession, visibleSession: visibleSession(), hint: '这个会话的右侧栏还没挂载，页面已排队，切回该会话时会自动打开。' };
          }
        }
        if (!view) {
          uiDrove = uiDrove || 'address-bar';
          await navigateViaPanelUi(target);
          view = await waitForWebview(8000, callerSession);
        }
        if (!view) throw new Error('没找到浏览器面板：请先在右侧栏打开“浏览器”标签页（bootstrap=' + uiDrove + '，诊断：' + JSON.stringify(diagnose()) + '）');
        installSameTabPolicy(view);
        try { view.focus(); } catch {}
        const normalize = (value) => String(value || '').replace(/\/+$/, '');
        let loadError = null;
        let current = '';
        try { current = typeof view.getURL === 'function' ? String(view.getURL() || '') : ''; } catch {}
        if (normalize(current) !== normalize(target)) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await view.loadURL(target);
              loadError = null;
              break;
            } catch (error) {
              const message = String(error && error.message ? error.message : error);
              let now = '';
              try { now = String(view.getURL() || ''); } catch {}
              if (normalize(now) === normalize(target)) { loadError = null; break; }
              // A bootstrap navigation already heading to this URL reports ERR_ABORTED;
              // that is not a failure, the page is loading.
              if (/ERR_ABORTED|\(-3\)/.test(message)) { loadError = null; break; }
              loadError = message;
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
          }
        }
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          let loading = false;
          try { loading = typeof view.isLoading === 'function' ? Boolean(view.isLoading()) : false; } catch {}
          if (!loading) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const finalState = await stateOf(view);
        if (loadError && normalize(finalState.url) !== normalize(target)) {
          throw new Error('打不开 ' + target + '：' + loadError);
        }
        cleanupEmptyTabs(view).catch(() => {});
        return { state: finalState };
      }
      if (op === 'page-diag') {
        // Runs in the DSH page (not the guest): helps attribute UI-level CPU burn.
        const mode = String((args && args.mode) || 'report');
        if (mode === 'raf') {
          // Who keeps the page at ~144 frames per second? Capture rAF call sites for 1s.
          const original = window.requestAnimationFrame;
          const counts = new Map();
          let calls = 0;
          window.requestAnimationFrame = function instrumented(callback) {
            calls += 1;
            try {
              const stack = String(new Error().stack || '').split('\n').slice(1, 5).join(' | ').replace(/\s+/g, ' ').slice(0, 240);
              counts.set(stack, (counts.get(stack) || 0) + 1);
            } catch {}
            return original.call(window, callback);
          };
          await new Promise((resolve) => setTimeout(resolve, 1000));
          window.requestAnimationFrame = original;
          const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([stack, count]) => ({ count, stack }));
          return { calls, top };
        }
        if (mode === 'pause' || mode === 'resume') {
          const animations = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
          for (const animation of animations) {
            try { if (mode === 'pause') animation.pause(); else animation.play(); } catch {}
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { mode, touched: animations.length };
        }
        const describe = (element) => {
          let node = element;
          for (let depth = 0; depth < 8 && node; depth += 1) {
            const cls = String(node.className || '');
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && /row|message|step|status|tool|state/i.test(cls)) return text.slice(0, 100);
            node = node.parentElement;
          }
          return '';
        };
        const animations = typeof document.getAnimations === 'function'
          ? document.getAnimations().map((animation) => {
            let target = '';
            let hint = '';
            try {
              const element = animation.effect && animation.effect.target;
              if (element) {
                target = element.tagName + '.' + String(element.className || '').slice(0, 40);
                hint = describe(element);
              }
            } catch {}
            return { name: animation.animationName || String(animation.constructor && animation.constructor.name), target, hint, state: animation.playState };
          })
          : [];
        const frames = await new Promise((resolve) => {
          let count = 0;
          const start = performance.now();
          const tick = () => {
            count += 1;
            if (performance.now() - start < 1000) requestAnimationFrame(tick);
            else resolve(count);
          };
          requestAnimationFrame(tick);
        });
        return {
          frames,
          animations: animations.slice(0, 25),
          animationCount: animations.length,
          nodes: document.querySelectorAll('*').length,
          focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
          visibility: document.visibilityState,
        };
      }
      /* These ops manage tabs or report diagnostics; they work without a mounted
         page and are safe from any session. Everything else needs its own view. */
      const panelFreeOps = ['tabs', 'tab-close', 'sweep', 'probe', 'page-state'];
      const view = panelFreeOps.includes(op) ? null : await waitForWebview(4000, callerSession);
      if (!view && !panelFreeOps.includes(op)) throw new Error('没找到浏览器面板：请先在右侧栏打开“浏览器”标签页');
      if (op === 'state') return { state: await stateOf(view) };
      if (op === 'evaluate') return { value: await guestEval(view, String((args && args.code) || 'null')) };
      if (op === 'snapshot') return await guestSnapshot(view);
      if (op === 'click') return doClick(view, args);
      if (op === 'type') return doType(view, args);
      if (op === 'press') return doPress(view, args);
      if (op === 'zoom') {
        // Zoom is the guest's own page zoom (the same control Ctrl+= uses), so the
        // layout reflows instead of the page being scaled like an image.
        const wanted = Number(args && args.factor);
        const readZoom = () => {
          try { return typeof view.getZoomFactor === 'function' ? Number(view.getZoomFactor()) || 1 : 1; } catch (error) { return 1; }
        };
        if (!Number.isFinite(wanted) || wanted <= 0) return { ok: true, factor: readZoom() };
        const next = Math.min(5, Math.max(0.25, wanted));
        if (typeof view.setZoomFactor === 'function') {
          view.setZoomFactor(next);
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { ok: true, factor: readZoom(), mode: 'webview' };
        }
        await view.executeJavaScript('document.documentElement.style.zoom=' + JSON.stringify(String(next)), true);
        return { ok: true, factor: next, mode: 'css' };
      }      if (op === 'scroll') return doScroll(view, args);
      if (op === 'back') { if (typeof view.goBack === 'function') view.goBack(); else await guestEval(view, 'history.back()'); return { ok: true }; }
      if (op === 'forward') { if (typeof view.goForward === 'function') view.goForward(); else await guestEval(view, 'history.forward()'); return { ok: true }; }
      if (op === 'reload') { if (typeof view.reload === 'function') view.reload(); return { ok: true }; }
      if (op === 'stop') { if (typeof view.stop === 'function') view.stop(); return { ok: true }; }
      if (op === 'screenshot') {
        if (typeof view.capturePage !== 'function') throw new Error('webview 不支持 capturePage');
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const image = await view.capturePage();
            const dataUrl = image && typeof image.toDataURL === 'function' ? image.toDataURL() : '';
            if (dataUrl) return { dataUrl };
            lastError = '空截图';
          } catch (error) {
            lastError = String(error && error.message ? error.message : error);
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        throw new Error('截图失败（窗口被遮挡或渲染进程不可见）：' + lastError);
      }
      if (op === 'sweep-stale') {
        /* Only blank start-page tabs of the caller's own session. Hidden sessions
           have no mounted webviews by design, so the old "no webview = dead" rule
           closed every other conversation's panel. */
        const right = sidebarRight();
        const sweepSession = String((args && args.session) || '') || visibleSession();
        const live = new Set([...document.querySelectorAll('webview')].map((element) => tabIdOf(element)).filter(Boolean));
        const isStaleTab = (tab) => {
          if (!tab || !tab.sessionId || tab.sessionId !== sweepSession) return false;
          if (live.has(tab.tabId)) return false;
          const chip = tabChip(tab.tabId);
          const label = chip ? String(chip.textContent || '').replace(/\s+/g, ' ').trim() : '';
          return label === '浏览器' || label === 'Browser';
        };
        let closed = 0;
        for (const tab of browserTabs().filter(isStaleTab)) {
          if (right && tab.sessionId && typeof right.closeIn === 'function') {
            try { right.closeIn(tab.sessionId, tab.tabId); closed += 1; } catch {}
          } else {
            const chip = tabChip(tab.tabId);
            const closer = chip ? chip.querySelector('[aria-label*="关闭"], [aria-label*="Close"]') : null;
            if (closer) { try { closer.click(); closed += 1; } catch {} }
          }
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return { ok: true, closed, remaining: browserTabs().length };
      }
      if (op === 'tab-switch') {
        const resolvedTab = resolveTab(args);
        if (resolvedTab.error) throw new Error(resolvedTab.error);
        const tab = resolvedTab.tab;
        const tabId = tab.tabId;
        const activated = await activateTab(tabId);
        const view = await ensureVisibleWebview();
        return { ok: activated, tabId, title: tab.title || null, src: view ? view.getAttribute('src') : null };
      }
      if (op === 'tab-close') {
        const resolvedTab = resolveTab(args);
        if (resolvedTab.error) return { ok: false, error: resolvedTab.error };
        const tab = resolvedTab.tab;
        const tabId = tab.tabId;
        const right = sidebarRight();
        if (right && tab.sessionId && typeof right.closeIn === 'function') {
          try { right.closeIn(tab.sessionId, tabId); } catch {}
        } else {
          const chip = tabChip(tabId);
          const closer = chip ? chip.querySelector('[aria-label*="关闭"], [aria-label*="Close"]') : null;
          if (closer) { try { closer.click(); } catch {} }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { ok: true, tabId, remaining: browserTabs().length };
      }
      if (op === 'tab-new') {
        const url = String(args.url || '');
        const right = sidebarRight();
        if (!right || typeof right.openTab !== 'function') throw new Error('面板不支持 openTab');
        right.openTab('browser', { params: { url } });
        const view = await waitForWebview(15000, callerSession);
        return { ok: Boolean(view), url, src: view ? view.getAttribute('src') : null };
      }
      if (op === 'reveal') {
        revealPanel = Boolean(args && args.allow);
        return { ok: true, revealPanel };
      }
      if (op === 'expand') {
        /* One-shot "show me the panel" for a first click when the user never opened
           the right sidebar. Unlike reveal, this does not persist the preference.
           With several tabs open the wanted URL decides which tab becomes active. */
        const wanted = String((args && args.url) || '');
        const normalize = (value) => String(value || '').split('#')[0].replace(/\/+$/, '').toLowerCase();
        const target = normalize(wanted);
        const saved = revealPanel;
        revealPanel = true;
        try { expandRightbar(); } catch { /* layout service unavailable */ }
        const expandSession = visibleSession();
        const views = [...document.querySelectorAll('webview')].filter((element) => !expandSession || ownerSession(element) === expandSession);
        const match = (target && views.find((element) => {
          try { return normalize(element.getURL && element.getURL()) === target; } catch { return false; }
        })) || views.find((element) => {
          try { return normalize(element.getURL && element.getURL()).includes(target.split('/')[2] || ''); } catch { return false; }
        }) || view;
        if (match) {
          const tabId = tabIdOf(match);
          if (tabId) await activateTab(tabId);
        }
        revealPanel = saved;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { ok: true, tabId: match ? tabIdOf(match) : null };
      }
      if (op === 'tabs') {
        const close = Boolean(args && args.close);
        const views = [...document.querySelectorAll('webview')];
        const keep = new Set(views.map((element) => tabIdOf(element)).filter(Boolean));
        const right = sidebarRight();
        const visible = visibleSession();
        /* Cleaning "stale" tabs must stay inside the caller's own session: tabs of
           other sessions have no mounted webview while hidden, and treating that as
           dead would wipe every background conversation's panel. Blank start-page
           tabs only, never one that already shows a page. */
        const closeSession = String((args && args.session) || '') || visible;
        const isStaleTab = (tab) => {
          if (!tab || !tab.sessionId || tab.sessionId !== closeSession) return false;
          if (keep.has(tab.tabId)) return false;
          const chip = tabChip(tab.tabId);
          const label = chip ? String(chip.textContent || '').replace(/\s+/g, ' ').trim() : '';
          return label === '浏览器' || label === 'Browser';
        };
        const describe = () => browserTabs().map((tab) => describeBrowserTab(tab, visible));
        let closed = 0;
        if (close && right && typeof right.closeIn === 'function') {
          for (const tab of browserTabs().filter(isStaleTab)) {
            try { right.closeIn(tab.sessionId, tab.tabId); closed += 1; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
        }
        if (close) {
          // Fallback for tabs whose closeIn call does not take effect: hit their chip X.
          for (const tab of browserTabs().filter(isStaleTab)) {
            const chip = tabChip(tab.tabId);
            const closer = chip ? chip.querySelector('[aria-label*="关闭"], [aria-label*="Close"]') : null;
            if (closer) { try { closer.click(); closed += 1; } catch {} }
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
        }
        return {
          visibleSession: visible,
          tabs: describe(),
          keep: [...keep],
          closed,
          remaining: browserTabs().length,
          queued: [...pendingOpens.entries()].map(([sessionId, entry]) => ({
            sessionId,
            url: entry && typeof entry === 'object' ? String(entry.url || '') : String(entry || ''),
            at: entry && typeof entry === 'object' ? Number(entry.at) || 0 : 0,
          })),
          replays: replayLog.slice(-10),
        };
      }
      if (op === 'sweep') {
        /* Same containment as sweep-stale: only blank start-page tabs of the visible
           session; other sessions intentionally have no mounted webview. */
        const right = sidebarRight();
        const scope = String((args && args.session) || '') || visibleSession();
        const views = [...document.querySelectorAll('webview')];
        const keep = new Set(views.map((element) => tabIdOf(element)).filter(Boolean));
        const isStaleTab = (tab) => {
          if (!tab || !tab.sessionId || tab.sessionId !== scope) return false;
          if (keep.has(tab.tabId)) return false;
          const chip = tabChip(tab.tabId);
          const label = chip ? String(chip.textContent || '').replace(/\\s+/g, ' ').trim() : '';
          return label === '浏览器' || label === 'Browser';
        };
        let closed = 0;
        for (const tab of browserTabs().filter(isStaleTab)) {
          if (right && tab.sessionId && typeof right.closeIn === 'function') {
            try { right.closeIn(tab.sessionId, tab.tabId); closed += 1; } catch {}
          } else {
            const chip = tabChip(tab.tabId);
            const closer = chip ? chip.querySelector('[aria-label*="关闭"], [aria-label*="Close"]') : null;
            if (closer) { try { closer.click(); closed += 1; } catch {} }
          }
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return { ok: true, closed, remaining: browserTabs().length };
      }
      if (op === 'focus') {
        // Make the panel show the tab whose guest matches the given URL (CDP drives the
        // page directly, so the visible tab has to be aligned explicitly).
        const wanted = String((args && args.url) || '');
        const normalize = (value) => String(value || '').split('#')[0].replace(/\/+$/, '').toLowerCase();
        const target = normalize(wanted);
        const focusSession = visibleSession();
        const views = [...document.querySelectorAll('webview')].filter((element) => !focusSession || ownerSession(element) === focusSession);
        const view = views.find((element) => {
          let url = '';
          try { url = element.getURL ? String(element.getURL() || '') : ''; } catch {}
          return target && normalize(url) === target;
        }) || views.find((element) => {
          let url = '';
          try { url = element.getURL ? String(element.getURL() || '') : ''; } catch {}
          return target && normalize(url).includes(target.split('/')[2] || '');
        });
        if (!view) return { ok: false, hint: '没有匹配的标签页', url: wanted };
        const tabId = tabIdOf(view);
        expandRightbar();
        if (tabId && revealPanel) await activateTab(tabId);
        return { ok: true, tabId, activated: revealPanel, url: typeof view.getURL === 'function' ? view.getURL() : '' };
      }
      if (op === 'close') {
        const tabId = tabIdOf(view);
        const right = sidebarRight();
        const entry = browserTabs().find((tab) => tab.tabId === tabId);
        if (right && entry && entry.sessionId && typeof right.closeIn === 'function') {
          right.closeIn(entry.sessionId, entry.tabId);
          return { ok: true, tabId };
        }
        const chip = tabChip(tabId);
        const closer = chip ? chip.querySelector('[aria-label*="关闭"], [aria-label*="Close"]') : null;
        if (!closer) throw new Error('没找到关闭按钮，请手动关掉“浏览器”标签页');
        closer.click();
        return { ok: true, tabId };
      }
      if (op === 'probe') {
        return {
          hasWebview: true,
          capabilities: capabilities(view),
          // The shipped shell gives each workspace one non-persistent session partition;
          // reading it here is how the agent can tell whether this tab shares cookies.
          partition: (view.getAttribute && view.getAttribute('partition')) || null,
          frameName: (view.getAttribute && view.getAttribute('name')) || null,
        };
      }
      throw new Error('未知命令: ' + op);
    }

    async function handleCommand(message) {
      // Hot reload can leave an older copy of this module running; only the newest
      // instance may answer Host commands, or replies race each other.
      if (typeof window !== 'undefined' && window.__KATT_BRIDGE_GEN__ !== bridgeGeneration) return;
      const id = message.id;
      const op = message.op;
      const args = message.args || {};
      try {
        const value = await runCommand(op, args);
        await post(RESULT_URL, { id, ok: true, value, v: VERSION });
      } catch (error) {
        await post(RESULT_URL, { id, ok: false, error: String(error && error.message ? error.message : error), v: VERSION });
      }
    }

    /* --------------------------------------------------------------- transport */

    let pollStarted = false;
    let pollStopped = false;

    // HTTP long-poll for commands. A plugin reload used to leave EventSource stuck in
    // CONNECTING, so plain POSTs (the same channel the heartbeats already use) are the
    // reliable way to reach the Host.
    async function pollLoop() {
      if (!canHostPanel) return;
      if (pollStarted) return;
      pollStarted = true;
      while (!pollStopped) {
        if (typeof window !== 'undefined' && window.__KATT_BRIDGE_GEN__ !== bridgeGeneration) return;
        try {
          const response = await fetch(apiBase() + PULL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ v: VERSION }),
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
          });
          if (!response.ok) throw new Error('pull ' + response.status);
          const data = await response.json().catch(() => null);
          const commands = data && Array.isArray(data.commands) ? data.commands : [];
          for (const command of commands) await handleCommand(command);
          if (data && data.stale) await new Promise((resolve) => setTimeout(resolve, 400));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    }

    async function bootstrap() {
      for (let index = 0; index < ORIGINS.length; index += 1) {
        try {
          const response = await fetch(apiBase() + HELLO_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ version: VERSION, href: location.href, origin: ORIGINS[index] || 'relative', driver: 'webview' }),
          });
          if (response.ok) { originIndex = index; break; }
        } catch {}
      }
      pollLoop();
    }

    function diagnose() {
      // Compact on purpose: this rides along with browser_state/browser_probe results.
      const out = { version: VERSION, generation: bridgeGeneration };
      try {
        const views = [...document.querySelectorAll('webview')];
        out.webviews = views.length;
        out.rects = views.map((el) => {
          const rect = el.getBoundingClientRect();
          return [Math.round(rect.width), Math.round(rect.height)];
        });
      } catch {}
      try {
        out.platform = {
          desktop: typeof globalThis.dshDesktop,
          protocol: globalThis.dshDesktop && globalThis.dshDesktop.protocolVersion,
          browser: Boolean(globalThis.dshDesktop && globalThis.dshDesktop.browser),
        };
      } catch {}
      try {
        out.sidebarRight = Boolean(sidebarRight());
        out.layout = Boolean(layout());
        out.browserTabs = browserTabs().length;
        out.visibleSession = visibleSession();
        const firstView = document.querySelector('webview');
        out.activeViewSession = ownerSession(firstView);
        out.viewSessions = [...document.querySelectorAll('webview')].map(ownerSession);
        out.viewStates = [...document.querySelectorAll('webview')].map((view) => {
          let url = '';
          let title = '';
          try { url = typeof view.getURL === 'function' ? String(view.getURL() || '') : ''; } catch (error) { /* detached */ }
          try { title = typeof view.getTitle === 'function' ? String(view.getTitle() || '') : ''; } catch (error) { /* detached */ }
          return { sessionId: ownerSession(view), url, title };
        });
      } catch {}
      try {
        // The shell assigns one non-persistent session partition per workspace; surface it so
        // cookie questions ("do these two tabs share a jar?") are answerable from a tool call.
        const view = document.querySelector('webview');
        if (view) {
          out.partition = view.getAttribute('partition') || null;
          out.frameName = view.getAttribute('name') || null;
        }
      } catch {}
      return out;
    }

    let lastProbeKey = '';
    let lastProbeAt = 0;
    let lastStateKey = '';
    /** Replay one queued open when its own session becomes the visible one. */
    function replayPendingOpen() {
      try {
        const session = visibleSession();
        if (!session || pendingOpens.size === 0) return;
        const entry = pendingOpens.get(session);
        const url = entry && typeof entry === 'object' ? entry.url : entry;
        const queuedAt = entry && typeof entry === 'object' ? Number(entry.at) || 0 : 0;
        /* A queued page should not surprise the user hours later. */
        if (queuedAt && Date.now() - queuedAt > 2 * 60 * 60 * 1000) { pendingOpens.delete(session); return; }
        if (!url) return;
        const ownedViews = [...document.querySelectorAll('webview')].filter((view) => ownerSession(view) === session);
        if (ownedViews.length > 0) {
          /* Switching back mounts the panel on its last page; the queued page still
             has to open, or the request would be dropped silently. */
          let current = '';
          try { current = typeof ownedViews[0].getURL === 'function' ? String(ownedViews[0].getURL() || '') : ''; } catch (error) { current = ''; }
          pendingOpens.delete(session);
          const strip = (value) => String(value || '').split('#')[0].replace(/\/+$/, '');
          if (strip(current) === strip(url)) return;
          try { replayLog.push({ session, url, at: Date.now() }); while (replayLog.length > 10) replayLog.shift(); } catch (error) { /* diagnostics */ }
          runCommand('open', { url, session }).catch(() => {});
          return;
        }
        pendingOpens.delete(session);
        try { replayLog.push({ session, url, at: Date.now() }); while (replayLog.length > 10) replayLog.shift(); } catch (error) { /* diagnostics */ }
        runCommand('open', { url, session }).catch(() => {});
      } catch (error) { /* retry next heartbeat */ }
    }

    async function heartbeat() {
      if (!canHostPanel) return;
      /* Remember URL/title for every mounted tab; prune tabs that are gone. */
      try {
        for (const view of document.querySelectorAll('webview')) {
          const tabId = tabIdOf(view);
          if (!tabId) continue;
          tabMemory.set(tabKeyOf({ sessionId: ownerSession(view), tabId }), {
            url: typeof view.getURL === 'function' ? String(view.getURL() || '') : '',
            title: typeof view.getTitle === 'function' ? String(view.getTitle() || '') : '',
            at: Date.now(),
          });
        }
        const alive = new Set(browserTabs().map((tab) => tabKeyOf(tab)));
        for (const key of [...tabMemory.keys()]) { if (!alive.has(key)) tabMemory.delete(key); }
      } catch (error) { /* best effort */ }
      replayPendingOpen();
      if (typeof window !== 'undefined' && window.__KATT_BRIDGE_GEN__ !== bridgeGeneration) return;
      // Self-heal: the heartbeat proves the Host is up, so keep the command poll attached.
      if (!pollStarted && !pollStopped) pollLoop();
      // A background window has no one looking at the panel; skip the round trips entirely.
      const hidden = typeof document !== 'undefined' && Boolean(document.hidden);
      const view = findWebview();
      // Install the bridge-side helpers (same-tab policy + clipboard shim) even when no tool
      // call has attached CDP yet, so copy buttons work while the user browses on their own.
      if (view) installSameTabPolicy(view);
      const probe = { at: Date.now(), panel: true, hasWebview: Boolean(view), count: document.querySelectorAll('webview').length, diagnose: diagnose(), tabSessions: [...new Set(browserTabs().map((tab) => tab.sessionId).filter(Boolean))], v: VERSION };
      if (view) probe.capabilities = capabilities(view);
      // Only post when something actually changed: a quiet panel used to cost a POST every
      // 2.5s for identical data, and every reply woke the Host for nothing.
      const probeKey = JSON.stringify([probe.hasWebview, probe.count, probe.diagnose]);
      /* Re-post even without changes: a Host plugin reload clears its probe state,
         and the panel must reconnect without waiting for a visible change. A hidden
         window keeps a slower cadence so it costs almost nothing. */
      const interval = hidden ? 60000 : 15000;
      const due = Date.now() - lastProbeAt > interval;
      if (probeKey !== lastProbeKey || due) {
        lastProbeKey = probeKey;
        lastProbeAt = Date.now();
        const reply = await post(PROBE_URL, probe);
        if (reply && typeof reply.homeUrl === 'string' && reply.homeUrl !== '') homeUrl = reply.homeUrl;
      if (reply && typeof reply.driver === 'string' && reply.driver !== '') driverMode = reply.driver;
      if (reply && Number(reply.maxHeadlessBrowsers) > 0) maxHeadlessBrowsers = Math.floor(Number(reply.maxHeadlessBrowsers));
      if (reply && Number(reply.headlessInstances) >= 0) headlessInstances = Math.floor(Number(reply.headlessInstances));
      if (reply && typeof reply.restoreLastPage === 'boolean') restoreLastPage = reply.restoreLastPage;
      if (reply && reply.lastPages && typeof reply.lastPages === 'object') lastPages = reply.lastPages;
      if (reply && reply.sessionTitles && typeof reply.sessionTitles === 'object') sessionTitles = reply.sessionTitles;
      if (reply && reply.sessionMeta && typeof reply.sessionMeta === 'object') sessionMeta = reply.sessionMeta;
      }
      if (hidden) return;
      if (!view) {
        /* The tab was closed; clear the Host's page state so probe/doctor do not
           keep reporting a page that is no longer mounted. */
        if (!postedEmptyState) {
          postedEmptyState = true;
          lastStateKey = '';
          await post(PAGE_STATE_URL, { url: '', title: '', loading: false, ready: false, error: null, viewport: { width: 0, height: 0 }, panel: true, session: visibleSession(), v: VERSION });
        }
        return;
      }
      postedEmptyState = false;
      const state = await stateOf(view);
      const stateKey = JSON.stringify([state.url, state.title, state.loading, state.ready, state.error, state.viewport]);
      if (stateKey === lastStateKey) return;
      lastStateKey = stateKey;
      await post(PAGE_STATE_URL, { ...state, panel: true, session: visibleSession(), v: VERSION });
    }

    /* ---- panel chrome ----
       The shipped browser panel paints a centred "正在打开…" placeholder while a
       page loads. That reads like a stuck label; replace it with the browser
       convention: hide the placeholder, spin a ring at the end of the address bar.
       Everything here is presentation only and degrades to a no-op on other builds. */
    function installBrowserChrome() {
      try {
        if (typeof window === 'undefined' || window.__kattBrowserChrome) return;
        window.__kattBrowserChrome = true;
        const style = document.createElement('style');
        style.id = '__katt_browser_chrome_style';
        style.textContent = [
          '.katt-browser-root.katt-loading [class*="placeholder"]{display:none !important}',
          '.katt-browser-spinner{width:13px;height:13px;flex:none;margin:0 8px;border-radius:50%;box-sizing:border-box;',
          'border:1.5px solid currentColor;border-top-color:transparent;opacity:.6;display:none;',
          'animation:kattSpin .65s linear infinite}',
          '.katt-browser-root.katt-loading .katt-browser-spinner{display:inline-block}',
          '@keyframes kattSpin{to{transform:rotate(360deg)}}',
        ].join('');
        (document.head || document.documentElement).appendChild(style);
        const tick = () => {
          try {
            const input = document.querySelector('input[aria-label="输入 HTTP(S) 地址"], input[placeholder*="HTTP(S)"]');
            if (!input) return;
            const form = typeof input.closest === 'function' ? input.closest('form') : null;
            const root = form && form.parentElement ? form.parentElement : null;
            if (!root) return;
            root.classList.add('katt-browser-root');
            if (form && !form.querySelector('.katt-browser-spinner')) {
              const spinner = document.createElement('span');
              spinner.className = 'katt-browser-spinner';
              spinner.setAttribute('aria-hidden', 'true');
              form.appendChild(spinner);
            }
            const busy = Boolean(root.querySelector('[aria-busy="true"]'));
            root.classList.toggle('katt-loading', busy);
            /* Newer or older shells may render the label as plain text instead of the
               placeholder box; hide just those nodes, not the whole start screen. */
            for (const node of root.querySelectorAll('[class*="start"]')) {
              if (/正在打开|Opening\.\.\./.test((node.textContent || '').trim())) node.style.display = 'none';
            }
          } catch (error) { /* panel not mounted yet */ }
        };
        let scheduled = false;
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          window.requestAnimationFrame(() => { scheduled = false; tick(); });
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-busy', 'class'],
        });
        const timer = window.setInterval(tick, 1000);
        tick();
        window.__kattBrowserChromeStop = () => {
          try { observer.disconnect(); } catch (error) { /* already gone */ }
          window.clearInterval(timer);
          window.__kattBrowserChrome = false;
        };
      } catch (error) { /* presentation only */ }
    }

    /* ---- open the current file in the plugin browser ---- */
    function openFileInBrowser(filePath) {
      return fetch(apiBase() + OPEN_FILE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: filePath, session: visibleSession() }),
      })
        .then((response) => response.json().catch(() => null))
        .then((answer) => {
          if (!answer || answer.error) throw new Error((answer && answer.error) || '打开失败');
          return answer;
        });
    }

    /* ---- files navigator interception ----
       Clicking an .html entry in the workspace file list normally opens the shipped
       document preview (a sandboxed frame with no CDP). Route those clicks to this
       plugin's browser instead, so the page the user opens is the one the agent can
       read and click. Buttons inside a row keep their own behavior. */
    /* ---- global file-open interception ----
       Every "open this file" entry in the UI (chat file links, @ references, the
       files navigator, deliverables, skills) funnels into sidebarRight.openResource
       with a dsh-resource://file/... address. Wrap that method: web-page files are
       served and opened in this plugin's browser, everything else keeps the shipped
       document preview. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

    function isAbsoluteFsPath(value) {
      return /^[a-zA-Z]:[\\/]/.test(value) || /^[/\\]{2}/.test(value);
    }

    function resolveFileAddress(address) {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return '';
        const trimmed = address.slice(FILE_ADDRESS_PREFIX.length).split(/[?#]/)[0];
        const parts = trimmed.split('/');
        const scope = parts.shift();
        if (scope === 'absolute') {
          const decoded = parts.map((segment) => decodeURIComponent(segment));
          const path = decoded.join('/');
          return isAbsoluteFsPath(path) ? path : '/' + path;
        }
        if (scope !== 'session') return '';
        const sessionId = decodeURIComponent(parts.shift() || '');
        if (sessionId === '' || parts.length === 0) return '';
        const relative = parts.map((segment) => decodeURIComponent(segment)).join('/');
        if (isAbsoluteFsPath(relative)) return relative;
        let cwd = '';
        try { cwd = String(pluginCtx && pluginCtx.sessions.list.getSnapshot().byId[sessionId]?.cwd || ''); } catch (error) { cwd = ''; }
        if (cwd === '') return '';
        const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
        return root + '/' + relative.replace(/^\/+/, '');
      } catch (error) { return ''; }
    }

    function isHtmlPath(filePath) {
      return /\.html?$/i.test(String(filePath || ''));
    }

    function installFileOpenServiceInterceptor() {
      try {
        if (typeof window === 'undefined' || window.__kattOpenResourcePatched) return;
        const service = pluginCtx && pluginCtx.sidebarRight;
        if (!service || typeof service.openResource !== 'function') return;
        const originals = {
          openResource: service.openResource,
          openResourceIn: typeof service.openResourceIn === 'function' ? service.openResourceIn : null,
        };
        const intercept = (address) => {
          const filePath = resolveFileAddress(address);
          if (filePath === '' || !isHtmlPath(filePath)) return false;
          openFileInBrowser(filePath).catch((failure) => {
            try { console.warn('[katt-browser] open in browser failed:', failure); } catch (ignored) { /* no console */ }
          });
          return true;
        };
        service.openResource = function (address, options) {
          try { if (intercept(address)) return; } catch (error) { /* fall through */ }
          return originals.openResource.call(this, address, options);
        };
        if (originals.openResourceIn !== null) {
          service.openResourceIn = function (sessionId, address, options) {
            try { if (intercept(address)) return; } catch (error) { /* fall through */ }
            return originals.openResourceIn.call(this, sessionId, address, options);
          };
        }
        window.__kattOpenResourcePatched = true;
        window.__kattBrowserDebugResolve = (address) => resolveFileAddress(address);
        window.__kattBrowserDebugOpen = (address) => service.openResource(address);
        window.__kattOpenResourceRestore = () => {
          try {
            service.openResource = originals.openResource;
            if (originals.openResourceIn !== null) service.openResourceIn = originals.openResourceIn;
          } catch (error) { /* already gone */ }
          window.__kattOpenResourcePatched = false;
        };
      } catch (error) { /* service not available */ }
    }

    function installFileOpenInterceptor() {
      try {
        if (typeof window === 'undefined' || window.__kattFileOpenInterceptor) return;
        window.__kattFileOpenInterceptor = true;
        const handled = new Map();
        const decide = (event) => {
          if (!event || event.defaultPrevented) return '';
          if (typeof event.button === 'number' && event.button > 0) return '';
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return '';
          if (target.closest('input, select, textarea')) return '';
          const row = target.closest('[data-files-entry="file"][data-files-path]');
          if (!row) return '';
          /* The row's open control is a <button> wrapping the file name; any other
             button inside the row (an action menu) keeps its own behavior. */
          const button = target.closest('button, a');
          if (button) {
            const name = row.querySelector('[class*="_name_"]');
            if (name !== null && !button.contains(name)) return '';
          }
          const filePath = String(row.getAttribute('data-files-path') || '');
          if (!/\.html?$/i.test(filePath)) return '';
          if (!/^[a-zA-Z]:[\\/]/.test(filePath)) return '';
          return filePath;
        };
        const invoke = (event) => {
          try {
            const filePath = decide(event);
            if (filePath === '') return;
            event.preventDefault();
            event.stopPropagation();
            const now = Date.now();
            if (now - (handled.get(filePath) || 0) < 1500) return;
            handled.set(filePath, now);
            openFileInBrowser(filePath).catch((failure) => {
              try { console.warn('[katt-browser] open in browser failed:', failure); } catch (ignored) { /* no console */ }
            });
          } catch (error) { /* let the host handle it */ }
        };
        document.addEventListener('pointerdown', invoke, true);
        document.addEventListener('click', invoke, true);
        window.__kattFileOpenInterceptorStop = () => {
          try {
            document.removeEventListener('pointerdown', invoke, true);
            document.removeEventListener('click', invoke, true);
          } catch (error) { /* already gone */ }
          window.__kattFileOpenInterceptor = false;
        };
      } catch (error) { /* presentation only */ }
    }

    /* ---- settings section: browser tabs across sessions ----
       The right sidebar is per-session, so tabs belonging to other conversations are
       invisible in the panel. This list shows every tab with its session owner and
       lets the user close a leftover one without switching conversations. */
    function kattSettingsTabs() {
      try {
        const visible = visibleSession();
        return browserTabs().map((tab) => describeBrowserTab(tab, visible));
      } catch (error) { return []; }
    }

    function BrowserSettingsSection() {
      const [rows, setRows] = React.useState([]);
      const [queued, setQueued] = React.useState([]);
      const [visible, setVisible] = React.useState('');
      const refresh = React.useCallback(() => {
        setRows(kattSettingsTabs());
        const pending = [];
        try {
          for (const [sessionId, entry] of pendingOpens.entries()) {
            const url = entry && typeof entry === 'object' ? String(entry.url || '') : String(entry || '');
            pending.push({ sessionId, url });
          }
        } catch (error) { /* private to the running client instance */ }
        setQueued(pending);
        try { setVisible(visibleSession()); } catch (error) { setVisible(''); }
      }, []);
      React.useEffect(() => {
        refresh();
        const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 3000);
        return () => window.clearInterval(timer);
      }, [refresh]);
      const closeTab = (sessionId, tabId) => {
        try { const right = sidebarRight(); if (right && typeof right.closeIn === 'function') right.closeIn(sessionId, tabId); } catch (error) { /* gone */ }
        window.setTimeout(refresh, 150);
      };
      const cancelQueued = (sessionId) => {
        try { pendingOpens.delete(sessionId); } catch (error) { /* gone */ }
        window.setTimeout(refresh, 150);
      };
      const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 };
      const metaStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' };
      const buttonStyle = { flex: 'none', font: 'inherit', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', cursor: 'pointer' };
      const rowsView = rows.length === 0
        ? h('p', { style: metaStyle }, '还没有打开过浏览器标签页。')
        : h('div', null, rows.map((row) => h('div', { key: row.sessionId + row.tabId, style: rowStyle },
            h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', { style: { fontWeight: 500 } }, (row.visible ? '当前 · ' : '') + (sessionLabel(row.sessionId) ? sessionLabel(row.sessionId) + ' · ' : '') + (row.title || '浏览器标签页')),
              h('span', { style: metaStyle }, (row.sessionId || '未知会话').slice(0, 26) + (row.url ? ' · ' + row.url.slice(0, 80) : '') + (row.remembered ? '（上次查看）' : ''))
            ),
            row.url ? h('button', {
              onClick: () => { runCommand('open-here', { url: row.url }).catch(() => {}); window.setTimeout(refresh, 600); },
              style: buttonStyle,
              title: row.url || '',
            }, '在这里打开') : null,
            h('button', { onClick: () => closeTab(row.sessionId, row.tabId), style: buttonStyle }, '关闭')
          )));
      const queuedView = queued.length === 0
        ? null
        : h('div', null,
            h('h3', { style: { margin: '4px 0 0', fontSize: 13, fontWeight: 600 } }, '排队中的页面'),
            h('p', { style: metaStyle }, '发起工具时那个会话的右侧栏不可见，页面先排队；切回该会话时自动打开（2 小时内有效）。'),
            queued.map((entry) => h('div', { key: 'queued-' + entry.sessionId, style: rowStyle },
              h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                h('span', { style: { fontWeight: 500 } }, entry.url || '（无网址）'),
                h('span', { style: metaStyle }, (sessionLabel(entry.sessionId) ? sessionLabel(entry.sessionId) + ' · ' : '') + entry.sessionId.slice(0, 26))),
              entry.url ? h('button', { onClick: () => { pendingOpens.delete(entry.sessionId); runCommand('open-here', { url: entry.url }).catch(() => {}); window.setTimeout(refresh, 600); }, style: buttonStyle }, '在这里打开') : null,
              h('button', { onClick: () => cancelQueued(entry.sessionId), style: buttonStyle }, '取消'))));
      return h('section',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720, padding: '8px 0', color: 'var(--dsw-alias-label-primary)' } },
        h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '浏览器'),
        h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
          '所有会话的侧栏浏览器标签页。标签按会话隔离，关掉别的会话里遗留的标签不会影响当前会话正在看的页面。'),
        h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
          '驱动：' + (driverMode === 'headless' ? '无头浏览器（每会话独立 profile，当前 ' + headlessInstances + '/' + maxHeadlessBrowsers + ' 个实例）' : '侧栏 webview') + ' · 首页：' + homeUrl),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, '当前会话：' + (visible ? visible.slice(0, 22) + '…' : '未知') + ' · ' + rows.length + ' 个标签页' + (queued.length ? ' · 排队 ' + queued.length + ' 个' : '')),
          h('button', { onClick: refresh, style: buttonStyle }, '刷新')),
        rowsView,
        queuedView,
      );
    }

    function BrowserSettingsIcon(props) {
      const size = (props && Number(props.size)) || 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block', color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' } },
        h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M2.2 8h11.6M8 1.8c1.7 1.7 2.6 3.9 2.6 6.2S9.7 12.5 8 14.2C6.3 12.5 5.4 10.3 5.4 8S6.3 3.5 8 1.8Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1 }));
    }

    return {
      inject: ['sidebarRight', 'layout', 'sessions', 'slots'],
      apply(ctx) {
        try {
          if (React && ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.slots.inject('settings.section', () => {
              const sectionDisposers = [];
              try { sectionDisposers.push(ctx.slots.register({ name: 'settings.section', id: 'katt-browser', order: 14, label: () => '浏览器' }, BrowserSettingsSection)); } catch (error) { /* older shell */ }
              try { sectionDisposers.push(ctx.slots.register({ name: 'settings.section.icon', key: 'katt-browser' }, BrowserSettingsIcon)); } catch (error) { /* icon optional */ }
              return () => {
                for (const dispose of sectionDisposers) { try { dispose(); } catch (error) { /* gone */ } }
              };
            });
          }
        } catch (error) { /* settings section is optional */ }
        pluginCtx = ctx;
        if (typeof window !== 'undefined') window.__KATT_WEBVIEW_BRIDGE__ = true;
        bootstrap();
        heartbeat();
        installBrowserChrome();
        installFileOpenInterceptor();
        installFileOpenServiceInterceptor();
        installHomeTabDefault();
        installOmniboxSearch();
        if (pageStateTimer) clearInterval(pageStateTimer);
        pageStateTimer = setInterval(heartbeat, 8000);
        /* Replaying a queued page used to wait for the 8s heartbeat; a short timer
           opens it as soon as the user actually switches to the session. */
        if (replayTimer) clearInterval(replayTimer);
        replayTimer = setInterval(() => {
          try { if (pendingOpens.size > 0) replayPendingOpen(); } catch (error) { /* retry next tick */ }
        }, 2000);
        ctx.effect(() => () => {
          clearInterval(pageStateTimer);
          if (replayTimer) clearInterval(replayTimer);
          pollStopped = true;
          if (typeof window !== 'undefined' && window.__kattBrowserChromeStop) window.__kattBrowserChromeStop();
          if (typeof window !== 'undefined' && window.__kattFileOpenInterceptorStop) window.__kattFileOpenInterceptorStop();
          if (typeof window !== 'undefined' && window.__kattOpenResourceRestore) window.__kattOpenResourceRestore();
        });
      },
    };
  },
});
