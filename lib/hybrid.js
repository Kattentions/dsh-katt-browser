/**
 * katt-browser — hybrid driver.
 *
 * Prefers the real DevTools protocol (when the desktop app was started with
 * --remote-debugging-port) and falls back to the in-page webview bridge otherwise.
 * Tools always talk to this facade, so the driver can come up later than the plugin.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { attachBrowserGuest, probeCdp } from './cdp.js';
import { clearCache, clearCookies, clearSite, listCookies, listProfiles, loadProfile, saveProfile } from './profiles.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Evaluate results differ per driver: unwrap { result } wrappers, then JSON-parse strings. */
const unwrapEvaluate = (raw) => {
  let value = raw;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) value = value.result;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
};

const RETRY_WINDOW_MS = 20000;
const PROBE_COOLDOWN_MS = 30000;

const normalizeUrl = (value) => String(value || '').split('#')[0].replace(/\/+$/, '').toLowerCase();

export class HybridSession {
  constructor(config = {}, fallback) {
    this.config = config;
    this.fallback = fallback;
    this.port = Number(config.cdpPort) || 0;
    this.idbLimit = Number(config.idbLimit) || 50;
    this.instrument = config.instrument !== false;
    this.downloadDir = typeof config.downloadDir === 'string' && config.downloadDir.trim() ? config.downloadDir.trim() : '';
    this.revealPanel = config.revealPanel === true || String(config.revealPanel || '').toLowerCase() === 'always';
    this.revealSent = false;
    /* Beginners never open the right sidebar, then a click fails with "panel hidden".
       Expand it once by ourselves before giving up (rate-limited so it never fights
       the user's own collapse). */
    this.autoReveal = config.autoReveal !== false;
    this.autoRevealAt = 0;
    this.allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts.map((item) => String(item).toLowerCase()).filter(Boolean) : [];
    /* Default page for an unspecified navigation ("open the browser" with no URL). */
    this.homeUrl = typeof config.homeUrl === 'string' && config.homeUrl.trim() ? config.homeUrl.trim() : 'https://www.bing.com';
    this.homeSettled = false;
    /* Session that invoked the current tool call: the right side panel belongs to
       one session, and a call from another one must not drive it. */
    this.callerSession = '';
    /* Snapshot refs are per session: a ref from session A must never be resolved
       against a page the user is looking at in session B. */
    this.snapshotBySession = new Map();
    this.actionLog = [];
    this.attached = null;
    this.failedAt = 0;
    this.mode = 'bridge';
    this.swept = false;
    this.zoomFactor = 1;
    // A long-lived CDP attachment keeps Chromium from throttling the guest, so an idle
    // session detaches and reconnects lazily on the next tool call.
    const idleMs = Number(config.cdpIdleDetachMs);
    this.idleDetachMs = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : 45000;
    this.idleTimer = null;
  }

  setCallerSession(id) {
    this.callerSession = String(id || '');
    try { this.fallback.setCallerSession?.(this.callerSession); } catch {}
  }

  /**
   * Refuse to drive the panel when it belongs to a different session. The client
   * reports the mounted right-pane session in every probe, so the check costs one
   * cheap round trip and runs before anything navigates or expands.
   */
  /**
   * Remember an open request for the caller session. The client replays it when that
   * session's right pane becomes visible, so a page opened from a background
   * conversation lands in its own browser instead of hijacking the visible one.
   * @param {string} url - page to open later.
   * @returns {Promise<boolean>} whether the client accepted the queue entry.
   */
  async queueOpen(url) {
    const target = String(url || '').trim();
    if (!target || !this.callerSession) return false;
    try {
      const bridge = this.fallback && this.fallback.bridge ? this.fallback.bridge : this.fallback;
      if (!bridge || typeof bridge.sendCommand !== 'function') return false;
      await bridge.sendCommand('queueOpen', { url: target, session: this.callerSession }, 5000);
      return true;
    } catch (error) { return false; }
  }

  async guardSession() {
    if (!this.callerSession) return null;
    try { await this.fallback.refreshProbe?.(); } catch {}
    const probe = this.fallback.probe || {};
    const diagnose = probe.diagnose || {};
    /* Prefer the session that owns the mounted browser tab; fall back to the right
       pane the user is looking at when no tab exists yet. */
    /* A tab owned by the caller can be hidden right now; driving it is safe, it is
       only revealed when the user opens that session. */
    const viewSessions = Array.isArray(diagnose.viewSessions) ? diagnose.viewSessions : [];
    if (viewSessions.includes(this.callerSession)) return null;
    const visible = String(diagnose.activeViewSession || diagnose.visibleSession || '');
    if (visible && visible !== this.callerSession) {
      return {
        error: 'inactive-session',
        requestedSession: this.callerSession,
        visibleSession: visible,
        hint: '右侧栏浏览器现在显示的是另一个会话（' + visible + '），工具没有动它。请在发起工具的这个会话里使用，或者把 katt-browser 的 driver 改成 headless。',
      };
    }
    return null;
  }

  #cancelIdleDetach() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  #scheduleIdleDetach() {
    this.#cancelIdleDetach();
    if (!this.idleDetachMs) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const attached = this.attached;
      this.attached = null;
      this.mode = 'bridge';
      Promise.resolve(attached?.session?.detach?.()).catch(() => {});
    }, this.idleDetachMs);
    this.idleTimer.unref?.();
  }

  get state() {
    return this.fallback.state;
  }

  get probe() {
    return this.fallback.probe;
  }

  async refreshProbe() {
    await this.fallback.probeLive?.().catch?.(() => {});
    return this.probe;
  }

  get hello() {
    return this.fallback.hello;
  }

  get lastRevealAt() {
    return this.fallback.lastRevealAt;
  }

  get driver() {
    return this.attached ? 'cdp' : 'bridge';
  }

  get diagnostics() {
    return {
      mode: this.attached ? 'cdp' : 'bridge',
      target: this.attached && this.attached.target ? this.attached.target.url : null,
      failedAgoMs: this.failedAt ? Date.now() - this.failedAt : null,
      revealPanel: this.revealPanel,
      zoomFactor: this.zoomFactor,
      port: this.port,
    };
  }

  touch() {
    this.fallback.touch();
  }

  /** Attach once; bootstrap the sidebar guest through the bridge when needed. */
  async #attach(url) {
    if (this.attached) return this.attached;
    if (this.failedAt && Date.now() - this.failedAt < PROBE_COOLDOWN_MS) return null;
    /* CDP only when this session is the one on screen. The target list carries
       just URL/title, so a background session could otherwise attach to a
       same-URL tab in another session. Bridge ops are session-scoped. */
    try {
      const diagnose = (this.fallback.probe && this.fallback.probe.diagnose) || {};
      const visible = String(diagnose.activeViewSession || diagnose.visibleSession || '');
      if (this.callerSession && visible && visible !== this.callerSession) return null;
    } catch (error) { /* attach as before */ }
    const hint = url || this.state?.url || '';
    // Only a missing CDP endpoint deserves a long cooldown; "endpoint up but the guest is
    // still about:blank during navigation" must be retried on the next call immediately.
    const endpoint = await probeCdp(this.port).catch(() => null);
    if (!endpoint) {
      this.failedAt = Date.now();
      return null;
    }
    let attached = await attachBrowserGuest(this.port, hint, { idbLimit: this.idbLimit, instrument: this.instrument }).catch(() => null);
    if (attached) {
      this.attached = attached;
      this.mode = 'cdp';
      return attached;
    }
    if (!url) {
      this.failedAt = Date.now();
      return null;
    }
    // No target yet: let the shipped panel create its guest, then attach to it.
    try { await this.fallback.navigate(url); } catch {}
    const deadline = Date.now() + RETRY_WINDOW_MS;
    while (Date.now() < deadline && !attached) {
      await sleep(400);
      attached = await attachBrowserGuest(this.port, hint, { idbLimit: this.idbLimit, instrument: this.instrument }).catch(() => null);
    }
    if (!attached) {
      this.failedAt = Date.now();
      return null;
    }
    this.attached = attached;
    this.mode = 'cdp';
    this.#sweepOnce();
    return attached;
  }

  #scheduleSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      Promise.resolve(this.fallback.sweepStale?.()).catch(() => {});
    }, 3000);
  }

  #sweepOnce() {
    if (this.swept) return;
    this.swept = true;
    Promise.resolve(this.fallback.sweep?.()).catch(() => {});
  }

  async #alignVisible() {
    // The panel belongs to whatever session the user is looking at; never steal it from
    // another workspace unless the user opted in with revealPanel: true.
    if (!this.revealPanel) return;
    const attached = this.attached;
    if (!attached) return;
    const targetUrl = attached.target?.url || '';
    const visible = this.state?.url || '';
    if (!targetUrl) return;
    if (normalizeUrl(visible) === normalizeUrl(targetUrl)) return;
    await this.fallback.focusUrl?.(targetUrl).catch(() => {});
  }

  // Refs belong to one CDP attachment; silently falling back to the bridge would act on a
  // different element, so input actions never cross drivers.
  async #run(url, viaCdp, viaBridge, { refBound = false } = {}) {
    this.#cancelIdleDetach();
    this.#scheduleIdleDetach();
    if (this.revealSent !== this.revealPanel) {
      this.revealSent = this.revealPanel;
      Promise.resolve(this.fallback.setReveal?.(this.revealPanel)).catch(() => {});
    }
    /* A fresh install with the right sidebar closed has no guest at all; nothing can
       be driven until the panel mounts one. Expand it ourselves once. */
    if (this.#panelMissing()) await this.#ensurePanel().catch(() => {});
    const attached = await this.#attach(url).catch(() => null);
    if (attached) {
      await this.#alignVisible().catch(() => {});
      try {
        const result = await viaCdp(attached.session);
        // Popups create panel tabs a moment after the CDP target appears, so sweep dead
        // tabs shortly after every CDP action (debounced, only closes tabs without a guest).
        this.#scheduleSweep();
        return result;
      } catch (error) {
        // The guest may have navigated away or the endpoint died; retry through the bridge.
        this.attached = null;
        this.failedAt = Date.now();
        if (refBound) throw error;
        if (viaBridge) return viaBridge();
        throw error;
      }
    }
    return viaBridge ? viaBridge() : undefined;
  }

  async ensure() {
    const attached = await this.#attach().catch(() => null);
    if (!attached) return this.fallback.ensure();
    await this.#settleHome().catch(() => {});
    return attached.session;
  }

  /**
   * A freshly opened sidebar browser can still sit on about:blank (or an internal
   * new-tab page) when the first tool call arrives. Treat that as "no page
   * specified" and load the configured home once, so the browser never looks broken
   * with an empty panel.
   */
  async #settleHome() {
    if (this.homeSettled) return;
    this.homeSettled = true;
    const current = String(unwrapEvaluate(await this.evaluate('location.href').catch(() => '')) || '').trim();
    if (current !== '' && current !== 'about:blank' && !/^(chrome|edge|dsh|about):/i.test(current)) return;
    this.#record('home', { url: this.homeUrl });
    await this.#run(this.homeUrl,
      (session) => session.navigate(this.homeUrl),
      () => this.fallback.navigate(this.homeUrl));
  }

  async navigate(url, options = {}) {
    /* No explicit URL means "just open the browser": go to the configured home
       (Bing by default) instead of leaving whatever the sidebar happened to show. */
    const target = String(url || '').trim() || this.homeUrl;
    this.#assertAllowed(target);
    this.#record('navigate', { url: target });
    const waitFor = options && options.waitFor ? String(options.waitFor) : null;
    const waitMs = options && options.waitMs ? Math.max(0, Number(options.waitMs) || 0) : 0;
    const state = await this.#run(target,
      async (session) => {
        const next = await session.navigate(target);
        return { ...this.state, ...next, ready: true };
      },
      () => this.fallback.navigate(target));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30000)));
    if (waitFor) {
      // SPA shells finish loading before their feed renders; poll the selector instead of guessing.
      const deadline = Date.now() + 15000;
      let found = false;
      while (!found && Date.now() < deadline) {
        found = Boolean(await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(waitFor)}))`).catch(() => false));
        if (!found) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { ...state, waited: found, waitFor };
    }
    return state;
  }

  async barriers() {
    const snapshot = await this.evaluate(`(() => {
      const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 4000);
      const hasPassword = Boolean(document.querySelector('input[type="password"]'));
      const hasCaptcha = Boolean(document.querySelector('input[name*="captcha" i], input[id*="captcha" i], iframe[src*="captcha" i], .captcha, [class*="captcha" i]'));
      return JSON.stringify({ url: location.href, title: document.title, text, hasPassword, hasCaptcha });
    })()`).catch(() => null);
    if (!snapshot) return { checked: false };
    let page;
    try { page = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot; } catch { return { checked: false }; }
    const url = String(page.url || '');
    const text = String(page.text || '');
    const barriers = [];
    const isLoginPage = page.hasPassword || /\/(signin|login|sign_in|passport)\b/i.test(url);
    const realCaptcha = /人机验证|滑块|拖动滑块|滑动验证|安全验证|请完成下方验证|captcha|verify you are human/i.test(text) || page.hasCaptcha;
    // "验证码登录" on a signin page is a login method label, not a captcha challenge.
    if ((/sec\.douban\.com|slide|滑块|拖动滑块|请完成下方验证/i.test(url + ' ' + text) || page.hasCaptcha) || (realCaptcha && !isLoginPage)) {
      barriers.push({
        kind: 'captcha',
        advice: '这个站点要求人机验证/滑块验证，脚本无法代过。请在右侧栏手动完成验证（或登录），完成后告诉我继续。',
      });
    }
    if (/验证码|安全验证|人机验证|captcha|verify you are human|unusual traffic|访问异常/i.test(text) && !isLoginPage && !barriers.some((item) => item.kind === 'captcha')) {
      barriers.push({
        kind: 'captcha',
        advice: '页面出现验证码/安全验证，需要你在右侧栏手动输入或点击验证，然后我再继续。',
      });
    }
    const loginHints = /请登录|登录后|立即登录|账号登录|扫码登录|sign in to continue|log in to continue|sign in|log in/i.test(text)
      || /\/(signin|login|sign_in|passport)\b/i.test(url);
    if ((loginHints && (page.hasPassword || /\/signin|login|passport/i.test(url))) && !barriers.some((item) => item.kind === 'captcha')) {
      barriers.push({
        kind: 'login',
        advice: '这个页面需要登录才能看内容。请在右侧栏手动登录，登录完成后我可以用 browser_cookies save 保存状态，之后换会话直接恢复。',
      });
    }
    if (/访问过于频繁|请稍后再试|too many requests|rate limit|429/i.test(text)) {
      barriers.push({ kind: 'ratelimit', advice: '站点在限流，建议等几分钟或换网络环境再试。' });
    }
    if (/需要人工|人工审核|机器人检测|automated access|blocked/i.test(text) && barriers.length === 0) {
      barriers.push({ kind: 'manual', advice: '站点疑似在拦自动化访问，需要你手动操作或稍后重试。' });
    }
    return { checked: true, url, title: page.title || '', barriers };
  }

  async evaluate(code) {
    return this.#run(null,
      (session) => session.evaluate(String(code)),
      () => this.fallback.evaluate(String(code)));
  }

  async snapshot(detail) {
    const result = await this.#run(null,
      (session) => session.snapshot({ full: false, detail: detail === 'compact' ? 'compact' : 'full' }),
      () => this.fallback.snapshot());
    this.lastElements = Array.isArray(result && result.elements) ? result.elements : [];
    try { this.snapshotBySession.set(this.callerSession || '', this.lastElements); } catch {}
    return result;
  }

  #panelVisible() {    try {
      const probe = this.fallback.probe;
      if (!probe || !probe.at || Date.now() - probe.at > 30000) return true;
      /* A collapsed panel reports a 1×1 viewport and either no rects or zero rects;
         both mean "cannot receive real input". */
      const viewport = (probe.state && probe.state.viewport) || probe.viewport;
      if (viewport && Number(viewport.width) <= 1 && Number(viewport.height) <= 1) return false;
      const rects = probe.diagnose && Array.isArray(probe.diagnose.rects) ? probe.diagnose.rects : [];
      if (rects.length > 0) {
        return rects.some((rect) => Array.isArray(rect) && rect[0] > 10 && rect[1] > 10);
      }
      return true;
    } catch { return true; }
  }

  #hiddenHint(action) {
    return {
      panelHidden: true,
      action,
      hint: '右侧栏现在是收起状态（你可能切到了别的会话），真实鼠标/键盘输入需要面板展开。读页面、导航、console/网络、Cookie 都不受影响；要点击的话可以让用户展开面板，或者用 browser_evaluate 直接触发。',
    };
  }

  /** No guest mounted at all: a freshly installed plugin with the right sidebar closed. */
  #panelMissing() {
    try {
      const probe = this.fallback.probe;
      if (!probe) return true;
      if (probe.hasWebview === false) return true;
      const webviews = probe.diagnose && probe.diagnose.webviews;
      return Number(webviews) === 0;
    } catch { return true; }
  }

  /** Input is about to be sent: refresh the panel probe, expand it if needed. */
  async #readyForInput() {
    try { await this.fallback.refreshProbe?.(); } catch { /* stale probe only */ }
    if (!this.#panelMissing() && this.#panelVisible()) return true;
    return this.#ensurePanel();
  }

  /**
   * Expand the right sidebar when an input action needs a visible panel.
   * Rate-limited to once every 10 s so a user who deliberately collapsed the
   * panel does not get it reopened by every tool call.
   * @returns {Promise<boolean>} whether the panel is visible now.
   */
  async #ensurePanel() {
    try { await this.fallback.refreshProbe?.(); } catch { /* stale probe only */ }
    if (this.#panelVisible()) return true;
    if (!this.autoReveal) return false;
    if (Date.now() - this.autoRevealAt < 10000) return false;
    this.autoRevealAt = Date.now();
    const probe = this.fallback.probe || {};
    const url = (this.attached && this.attached.target && this.attached.target.url)
      || (this.state && this.state.url)
      || (probe.state && probe.state.url)
      || (probe.capabilities && probe.capabilities.src)
      || '';
    try { await this.fallback.expand?.(url); } catch { /* bridge unavailable */ }
    await sleep(700);
    try { await this.fallback.refreshProbe?.(); } catch { /* stale probe only */ }
    return this.#panelVisible();
  }

  async clickRef(ref, confirm = false) {
    const elements = (this.snapshotBySession && this.snapshotBySession.get(this.callerSession || '')) || this.lastElements || [];
    const target = elements.find((item) => Number(item.ref) === Number(ref));
    const label = target ? `${target.role || ''} ${target.name || ''}`.trim() : '';
    const risky = /删除|注销|退订|解绑|撤销|清空|重置|支付|付款|购买|下单|提交订单|确认删除|delete|remove|archive|unsubscribe|purchase|payment/i.test(label);
    if (risky && !confirm) {
      return { needsConfirm: true, ref, label, hint: `这一步可能是不可逆操作（${label}）。确认要执行的话，用 confirm=true 再点一次。` };
    }
    if (!(await this.#readyForInput())) return { ref, confirm, ...this.#hiddenHint('click') };
    this.#record('click', { ref, confirm });
    return this.#run(null,
      (session) => session.click(Number(ref)),
      () => this.fallback.clickRef(Number(ref)),
      { refBound: true });
  }

  async typeRef(ref, text, clear = false, submit = false) {
    if (!(await this.#readyForInput())) return { ref, ...this.#hiddenHint('type') };
    this.#record('type', { ref, length: String(text || '').length, submit });
    return this.#run(null,
      (session) => session.type(Number(ref), String(text), { clear, submit }),
      () => this.fallback.typeRef(Number(ref), String(text), clear, submit),
      { refBound: true });
  }

  async pressKey(name) {
    if (!(await this.#readyForInput())) return { key: name, ...this.#hiddenHint('press') };
    this.#record('press', { key: name });
    return this.#run(null,
      (session) => session.press(String(name)),
      () => this.fallback.pressKey(String(name)));
  }

  /**
   * Page zoom, driven through the panel's own webview (same control as Ctrl+=).
   * Steps are 0.1 so repeated calls feel like the browser's zoom shortcuts.
   *
   * @param {string} action - in, out, reset or set.
   * @param {number} [factor] - target factor for set.
   * @returns {Promise<{ok: boolean, action: string, factor: number}>} applied zoom.
   */
  async zoom(action = 'in', factor) {
    const current = Number(this.zoomFactor) > 0 ? Number(this.zoomFactor) : 1;
    const clamp = (value) => Math.min(5, Math.max(0.25, Math.round(value * 100) / 100));
    let next = current;
    if (action === 'in') next = clamp(current + 0.1);
    else if (action === 'out') next = clamp(current - 0.1);
    else if (action === 'reset') next = 1;
    else if (action === 'set') next = clamp(Number(factor) || current);
    let result = null;
    try {
      result = await this.fallback.setZoom(next);
    } catch (error) {
      result = null;
    }
    if (result && Number(result.factor) > 0) {
      this.zoomFactor = Number(result.factor);
    } else {
      /* No panel helper (headless driver or a stale page): fall back to CDP page
         scale, which needs no cooperation from the client half. */
      const attached = await this.#attach().catch(() => null);
      if (!attached) throw new Error('缩放失败：右侧栏浏览器没就绪');
      await attached.session.setPageZoom(next);
      this.zoomFactor = next;
    }
    this.#record('zoom', { action, factor: this.zoomFactor });
    return { ok: true, action, factor: this.zoomFactor };
  }

  async scroll(deltaY) {
    return this.#run(null,
      (session) => session.scroll(Number(deltaY)),
      () => this.fallback.scroll(Number(deltaY)));
  }

  async back() {
    return this.#run(null,
      (session) => session.goBack(),
      () => this.fallback.back());
  }

  async forward() {
    return this.#run(null,
      (session) => session.goForward(),
      () => this.fallback.forward());
  }

  /** Bring the sidebar browser tab to the front (used after opening a local file). */
  async reveal(url = '') {
    try { await this.fallback.expand?.(String(url || '')); } catch { /* bridge unavailable */ }
    await sleep(400);
    try { await this.fallback.refreshProbe?.(); } catch { /* stale probe only */ }
    return this.#panelVisible();
  }

  async reload() {    // Page.reload tears down the Electron guest; use the panel's own reload instead.
    this.attached = null;
    return this.fallback.reload();
  }

  async screenshot(name = 'shot') {
    return this.#run(null,
      async (session) => {
        const data = await session.screenshot();
        if (!data) throw new Error('CDP 截图返回空');
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const directory = path.join(os.tmpdir(), 'katt-browser-shots');
        mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${name}-${Date.now()}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        return { file, bytes: Math.round((data.length * 3) / 4) };
      },
      () => this.fallback.screenshot(name));
  }

  async cookiesAction(action, name) {
    if (action === 'list') {
      return this.#run(null,
        async (session) => listCookies(session),
        () => ({ error: 'Cookie 读取需要 CDP 驱动' }));
    }
    if (action === 'save') {
      return this.#run(null,
        async (session) => saveProfile(session, name),
        () => ({ error: 'Cookie 保存需要 CDP 驱动' }));
    }
    if (action === 'load') {
      return this.#run(null,
        async (session) => loadProfile(session, name),
        () => ({ error: 'Cookie 还原需要 CDP 驱动' }));
    }
    if (action === 'clear') {
      return this.#run(null,
        async (session) => clearCookies(session),
        () => ({ error: 'Cookie 清理需要 CDP 驱动' }));
    }
    if (action === 'clear-site') {
      return this.#run(null,
        async (session) => clearSite(session),
        () => ({ error: '站点数据清理需要 CDP 驱动' }));
    }
    if (action === 'clear-cache') {
      return this.#run(null,
        async (session) => clearCache(session),
        () => ({ error: '缓存清理需要 CDP 驱动' }));
    }
    return { error: `不支持的 action：${action}` };
  }

  async profiles() {
    return listProfiles();
  }

  async download(url, filename, saveDir) {
    const target = String(url || '').trim();
    if (!target) return { error: '需要提供 url' };
    return this.#run(null, async (session) => {
      const payload = await session.fetchResource(target);
      const rawName = filename || payload.filename || (() => {
        try { return decodeURIComponent(new URL(target).pathname.split('/').filter(Boolean).pop() || 'download'); } catch { return 'download'; }
      })();
      const safeName = String(rawName).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'download';
      const directory = saveDir ? String(saveDir) : (this.downloadDir || path.join(os.homedir(), 'Downloads', 'katt-browser'));
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, safeName);
      writeFileSync(file, Buffer.from(payload.base64, 'base64'));
      return { ok: true, file, size: payload.size, contentType: payload.contentType, status: payload.status };
    }, () => ({ error: '下载需要 CDP 驱动' }));
  }

  async tabSwitch(tabId) {
    this.#record('tab-switch', { tabId });
    const result = await this.fallback.switchTab(tabId);
    this.attached = null;
    this.mode = 'bridge';
    this.failedAt = null;
    const attached = await this.#attach(result && result.src ? result.src : null).catch(() => null);
    return { ...result, driver: attached ? 'cdp' : 'bridge' };
  }

  async tabNew(url) {
    this.#assertAllowed(url);
    this.#record('tab-new', { url: String(url) });
    const result = await this.fallback.newTab(url);
    this.attached = null;
    this.mode = 'bridge';
    this.failedAt = null;
    const attached = await this.#attach(url).catch(() => null);
    return { ...result, driver: attached ? 'cdp' : 'bridge' };
  }

  async tabClose(tabId) {
    this.#record('tab-close', { tabId });
    const result = await this.fallback.closeTab(tabId);
    this.attached = null;
    this.mode = 'bridge';
    return result;
  }

  async hoverAt(x, y) {
    return this.#run(null, (session) => session.hoverAt(x, y), () => ({ error: '悬停需要 CDP 驱动' }));
  }

  async clickAt(x, y, clicks) {
    return this.#run(null, (session) => session.clickAt(x, y, clicks), () => ({ error: '坐标点击需要 CDP 驱动' }));
  }

  async setFiles(selector, files) {
    this.#record('upload', { selector, count: Array.isArray(files) ? files.length : 1 });
    return this.#run(null, (session) => session.setFiles(selector, files), () => ({ error: '文件上传需要 CDP 驱动' }));
  }

  async scrollIntoView(selector) {
    return this.#run(null, (session) => session.scrollIntoView(selector), () => ({ error: '滚动定位需要 CDP 驱动' }));
  }

  /**
   * Wait until one of the conditions holds: a selector matches a visible element,
   * the page text contains a string, or the URL matches a prefix. Polls the guest.
   * @param {{ selector?: string, url?: string, text?: string, timeoutMs?: number }} [wanted]
   * @returns {Promise<object>} ok/waitedMs or timedOut with the last miss reason.
   */
  async waitFor(wanted = {}) {
    const total = Math.min(60000, Math.max(300, Number(wanted.timeoutMs) || 8000));
    const spec = JSON.stringify({
      selector: String(wanted.selector || ''),
      url: String(wanted.url || ''),
      text: String(wanted.text || ''),
    });
    const expression = `(() => {
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
        if (current !== target && !current.startsWith(target)) return JSON.stringify({ ok: false, reason: 'url', url: location.href });
      }
      return JSON.stringify({ ok: true, url: location.href, title: document.title });
    })()`;
    const started = Date.now();
    let last = 'unknown';
    let attempts = 0;
    while (Date.now() - started < total) {
      try {
        attempts += 1;
        const raw = await this.fallback.evaluate(String(expression));
        const parsed = unwrapEvaluate(raw);
        if (parsed && parsed.ok) return { ok: true, waitedMs: Date.now() - started, url: parsed.url, title: parsed.title };
        if (parsed && parsed.reason) last = parsed.reason;
      } catch (error) {
        let probe = 'n/a';
        try { probe = 'ok:' + String(await this.fallback.evaluate('1+1')); } catch (probeError) { probe = 'fail:' + String((probeError && probeError.message) || probeError); }
        last = 'error: ' + String((error && error.message) || error) + ' | probe=' + probe.slice(0, 120) + ' | tail=' + expression.slice(-320).replace(/\n/g, ' ');
      }
      await sleep(200);
    }
    return { ok: false, timedOut: true, waitedMs: Date.now() - started, lastMiss: last, attempts };
  }

  /**
   * Click the first element matched by a CSS selector or by visible text. Uses a
   * real mouse event under CDP; the bridge driver falls back to element.click().
   * @param {{ selector?: string, text?: string }} [target]
   * @returns {Promise<object>} what was clicked and whether it was real input.
   */
  async clickLocated(target = {}) {
    const spec = JSON.stringify({ selector: String(target.selector || ''), text: String(target.text || '') });
    const finder = `(() => {
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
      if (!el || !visible(el)) return JSON.stringify({ ok: false });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        ok: true,
        mode,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        tag: el.tagName.toLowerCase(),
        label: String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    })()`;
    if (!(await this.#readyForInput())) return { click: 'selector/text', ...this.#hiddenHint('click') };
    const raw = await this.evaluate(finder);
    const found = unwrapEvaluate(raw);
    if (!found || !found.ok) return { ok: false, error: '没有找到要点击的元素', selector: target.selector || '', text: target.text || '' };
    const meta = { mode: found.mode, tag: found.tag, label: found.label };
    const clickScript = `(() => {
      const want = ${spec};
      const visible = (el) => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      let el = want.selector ? document.querySelector(want.selector) : null;
      if (!el && want.text) el = [...document.querySelectorAll('button,a,[role="button"],[role="link"],input,label,li,span,div')]
        .find((node) => node.children.length <= 3 && visible(node) && String(node.innerText || node.value || '').trim().includes(want.text)) || null;
      if (!el) return JSON.stringify({ ok: false });
      el.click();
      return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
    })()`;
    return this.#run(null,
      async (session) => {
        // Arm a one-shot capture listener: if the compositor drops the synthesized
        // click (hidden panel, detached webview), fall back to a DOM click instead of
        // reporting success for a click that never happened.
        await session.evaluate('window.__kattClickSeen = false; if (!window.__kattClickProbe) { window.__kattClickProbe = true; document.addEventListener("click", function () { window.__kattClickSeen = true; }, true); }');
        await session.clickAt(found.x, found.y, 1);
        await sleep(250);
        const seen = await session.evaluate('Boolean(window.__kattClickSeen)');
        if (seen) return { ok: true, realInput: true, x: Math.round(found.x), y: Math.round(found.y), ...meta };
        const clicked = await session.evaluate(clickScript);
        const parsed = unwrapEvaluate(clicked);
        if (!parsed || !parsed.ok) return { ok: false, error: '鼠标事件没有命中元素，DOM 点击也找不到目标' };
        return { ok: true, realInput: false, fallback: 'dom-click', ...meta };
      },
      async () => {
        const clicked = await this.fallback.evaluate(clickScript);
        const parsed = unwrapEvaluate(clicked);
        if (!parsed || !parsed.ok) return { ok: false, error: '桥驱动没有找到要点击的元素' };
        return { ok: true, realInput: false, fallback: 'dom-click', ...meta };
      });
  }

  /** Page content as Markdown-ish text: headings, links, lists, tables, code. */
  async pageMarkdown(maxChars = 6000) {
    const limit = Math.min(60000, Math.max(500, Number(maxChars) || 6000));
    const expression = `(() => {
      const pick = () => {
        const candidates = [document.querySelector('article'), document.querySelector('main'), document.querySelector('[role="main"]')].filter(Boolean);
        candidates.push(document.body);
        let best = document.body;
        let bestScore = -1;
        for (const el of candidates) {
          if (!el) continue;
          const text = (el.innerText || '').trim();
          const score = text.length + (el.tagName === 'ARTICLE' ? 400 : 0) + (el.tagName === 'MAIN' ? 200 : 0);
          if (score > bestScore) { bestScore = score; best = el; }
        }
        return best;
      };
      const container = pick();
      const out = [];
      const push = (value) => { const text = String(value || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+$/u, ''); if (text.trim() !== '') out.push(text); };
      const walk = (node) => {
        if (node.nodeType === 3) { push(String(node.nodeValue || '').replace(/\\s+/g, ' ')); return; }
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'svg', 'iframe', 'form', 'button'].includes(tag)) return;
        if (/^h[1-6]$/.test(tag)) { push('\\n' + '#'.repeat(Number(tag[1])) + ' ' + String(node.innerText || '').replace(/\\s+/g, ' ').trim() + '\\n'); return; }
        if (tag === 'a') {
          const text = String(node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text === '') return;
          const href = node.getAttribute('href') || '';
          push('[' + text + '](' + href + ')');
          return;
        }
        if (tag === 'li') { push('\\n- ' + String(node.innerText || '').replace(/\\s+/g, ' ').trim()); return; }
        if (tag === 'br') { push('\\n'); return; }
        if (tag === 'pre' || tag === 'code') {
          const text = String(node.innerText || '').replace(/\\s+$/u, '');
          if (text.trim() !== '') push('\\n    ' + text.split('\\n').join('\\n    ') + '\\n');
          return;
        }
        if (tag === 'table') {
          const rows = [...node.querySelectorAll('tr')]
            .map((row) => [...row.querySelectorAll('th,td')].map((cell) => String(cell.innerText || '').replace(/\\s+/g, ' ').trim()).join(' | '))
            .filter((row) => row.trim() !== '');
          if (rows.length > 0) push('\\n' + rows.join('\\n') + '\\n');
          return;
        }
        for (const child of node.childNodes) walk(child);
      };
      walk(container);
      const markdown = out.join(' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      return JSON.stringify({ title: document.title, url: location.href, length: markdown.length, markdown: markdown.slice(0, ${limit}) });
    })()`;
    return this.#run(null,
      (session) => session.evaluate(expression).then(unwrapEvaluate),
      async () => unwrapEvaluate(await this.fallback.evaluate(expression)));
  }

  /** Readable page text: title + main content, nav/footer stripped. */
  async pageText(maxChars = 4000) {    const expression = `(() => {
      const pick = () => {
        const candidates = [document.querySelector('article'), document.querySelector('main'), document.querySelector('[role="main"]')].filter(Boolean);
        candidates.push(document.body);
        let best = document.body;
        let bestScore = -1;
        for (const el of candidates) {
          if (!el) continue;
          const text = (el.innerText || '').trim();
          const score = text.length + (el.tagName === 'ARTICLE' ? 400 : 0) + (el.tagName === 'MAIN' ? 200 : 0);
          if (score > bestScore) { bestScore = score; best = el; }
        }
        return best;
      };
      const container = pick();
      const clone = container.cloneNode(true);
      for (const node of clone.querySelectorAll('script,style,nav,footer,aside,noscript,svg')) node.remove();
      const text = (clone.innerText || '').replace(new RegExp('\\n{3,}', 'g'), '\\n\\n').trim();
      const links = [...container.querySelectorAll('a[href]')].slice(0, 40).map((a) => ({ text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60), href: a.href })).filter((item) => item.text);
      return JSON.stringify({ title: document.title, url: location.href, length: text.length, text: text.slice(0, ${Number(maxChars) || 4000}), links });
    })()`;
    return this.#run(null,
      (session) => session.evaluate(expression).then(unwrapEvaluate),
      async () => unwrapEvaluate(await this.fallback.evaluate(expression)));
  }

  /** Export every <table> on the page as headers + rows. */
  async pageTables(maxTables = 3, maxRows = 30) {
    const expression = `(() => {
      const tables = [...document.querySelectorAll('table')].slice(0, ${Number(maxTables) || 3}).map((table, index) => {
        const rows = [...table.querySelectorAll('tr')].slice(0, ${Number(maxRows) || 30}).map((row) => [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || '').replace(/\\s+/g, ' ').trim()));
        const header = rows.length > 0 && rows[0].length > 0 && [...table.querySelectorAll('th')].length > 0 ? rows[0] : null;
        return { index, header, rows: header ? rows.slice(1) : rows, rowCount: table.querySelectorAll('tr').length };
      });
      return JSON.stringify({ count: tables.length, tables });
    })()`;
    return this.#run(null,
      (session) => session.evaluate(expression).then(unwrapEvaluate),
      async () => unwrapEvaluate(await this.fallback.evaluate(expression)));
  }

  async consoleLogs(limit = 50, level) {
    return this.#run(null,
      (session) => session.consoleLogs(limit, level),
      () => ({ error: 'console 日志需要 CDP 驱动' }));
  }

  async networkLogs(limit = 50, filter) {
    return this.#run(null,
      (session) => session.networkLogs(limit, filter),
      () => ({ error: '网络历史需要 CDP 驱动' }));
  }

  async clearDiagnostics(kind) {
    return this.#run(null,
      (session) => (kind === 'network' ? session.clearNetwork() : session.clearConsole()),
      () => ({ error: '需要 CDP 驱动' }));
  }

  async instrumentData() {
    return this.#run(null,
      async (session) => {
        const data = await session.instrumentData();
        // Tool results must be lossless JSON: drop undefined fields left by optional data.
        return JSON.parse(JSON.stringify(this.#summarize(data)));
      },
      () => ({ error: 'CDP 未连接，仪表读取需要 CDP 驱动' }));
  }

  #record(action, detail = {}) {
    try {
      this.actionLog.push({ at: Date.now(), action, ...detail });
      if (this.actionLog.length > 200) this.actionLog.shift();
    } catch {}
  }

  clearHistory() {
    const removed = this.actionLog.length;
    this.actionLog = [];
    return { cleared: removed };
  }

  actionHistory(limit = 50) {
    return { total: this.actionLog.length, entries: this.actionLog.slice(-Math.max(1, Number(limit) || 50)) };
  }

  #assertAllowed(url) {
    if (this.allowedHosts.length === 0) return;
    let host = '';
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch {}
    const allowed = this.allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!allowed) throw new Error(`域名不在白名单里：${host || url}（allowedHosts）`);
  }

  #summarize(data) {
    if (!data) return { error: '没有仪表数据' };
    const messages = (data.out || []).slice().reverse();
    let summary = null;
    for (const entry of messages) {
      const message = entry && entry.message;
      const args = message && message.args;
      const state = args && args[0];
      if (state && Array.isArray(state.board)) {
        summary = {
          kind: message.call || message.type,
          state: state.state,
          score: state.score,
          moveCount: state.moveCount,
          highestReachedTile: state.highestReachedTile,
          board: state.board.map((row) => row.map((tile) => (tile && typeof tile.value === 'number' ? tile.value : 0))),
          lastChanges: (state.changes || []).map((change) => change.type).slice(0, 6),
        };
        break;
      }
    }
    return {
      workers: data.workers || [],
      storageKeys: (data.storage || []).map((entry) => entry.key),
      workerMessages: (data.out || []).length,
      workerReplies: data.inCount || 0,
      network: (data.net || []).map((entry) => ({
        kind: entry.kind,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        contentType: entry.contentType,
        messages: entry.messages,
        preview: entry.preview ? entry.preview.slice(0, 200) : undefined,
      })),
      summary,
    };
  }

  async listTabs(closeExtras = false) {
    return this.#run(null,
      async (session) => ({ driver: 'cdp', note: 'CDP 模式下标签页由页面自己管理', ...(await this.fallback.listTabs(closeExtras)) }),
      () => this.fallback.listTabs(closeExtras));
  }

  async hardClose() {
    const attached = this.attached;
    this.attached = null;
    this.mode = 'bridge';
    try { await attached?.connection?.close(); } catch {}
    return this.fallback.hardClose();
  }

  async pageDiagnostics(mode = 'report') {
    // This inspects the DSH UI itself, so it always goes through the page bridge.
    return this.fallback.pageDiagnostics(mode);
  }

  setViewport(width, height) {
    return this.fallback.setViewport(width, height);
  }

  noteVisibility(id, visible) {
    return this.fallback.noteVisibility(id, visible);
  }

  dispose() {
    this.#cancelIdleDetach();
    try { this.attached?.connection?.close(); } catch {}
    this.attached = null;
    this.fallback.dispose();
  }
}
