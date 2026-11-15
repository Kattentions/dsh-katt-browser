// Cookie / web storage / IndexedDB snapshots: the multi-account layer.
//
// The sidebar browser shares one non-persistent Electron session partition per workspace,
// so "switch account" means: save the current jar to a file, clear, then restore another.
//
// Snapshots contain live login state, so they are written AES-256-GCM encrypted with a
// per-user key under ~/.dsh/katt-browser/profile.key (mode 0600). Legacy plaintext files
// still load, and get re-saved encrypted on the next save.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'katt-browser', 'profiles');
const KEY_FILE = path.join(os.homedir(), '.dsh', 'katt-browser', 'profile.key');
const FORMAT = 'katt-profile-1';

const safeName = (name) => String(name || 'default').replace(/[^\w.-]/g, '_');

const loadKey = () => {
  try {
    const existing = readFileSync(KEY_FILE);
    if (existing.length === 32) return existing;
  } catch {}
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
};

const encryptPayload = (payload) => {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: FORMAT,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }, null, 2);
};

const decryptPayload = (raw) => {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.format !== FORMAT) return parsed; // legacy plaintext snapshot
  const key = loadKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(text);
};

const summary = (cookies) => cookies.map((cookie) => ({
  name: cookie.name,
  domain: cookie.domain,
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  session: cookie.session,
}));

export function listProfiles() {
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
    const files = readdirSync(PROFILE_DIR).filter((file) => file.endsWith('.json'));
    const profiles = files.map((file) => {
      const filePath = path.join(PROFILE_DIR, file);
      let meta = null;
      try {
        const payload = decryptPayload(readFileSync(filePath, 'utf8'));
        meta = {
          savedAt: payload.savedAt,
          encrypted: true,
          cookies: Array.isArray(payload.cookies) ? payload.cookies.length : 0,
          indexedDB: payload.storage && Array.isArray(payload.storage.idb) ? payload.storage.idb.length : 0,
          caches: payload.storage && Array.isArray(payload.storage.caches)
            ? payload.storage.caches.reduce((sum, cache) => sum + (cache.entries || []).length, 0)
            : 0,
        };
      } catch {}
      return { name: file.replace(/\.json$/, ''), ...meta };
    });
    return { directory: PROFILE_DIR, keyFile: KEY_FILE, profiles };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

export async function listCookies(session) {
  const list = await session.cookies();
  return { count: list.length, cookies: summary(list), profileDir: PROFILE_DIR };
}

export async function saveProfile(session, name) {
  const cookies = await session.cookies();
  const storage = await session.storageSnapshot().catch(() => null);
  mkdirSync(PROFILE_DIR, { recursive: true });
  const file = path.join(PROFILE_DIR, `${safeName(name)}.json`);
  const payload = { savedAt: new Date().toISOString(), cookies, storage };
  writeFileSync(file, encryptPayload(payload), { encoding: 'utf8', mode: 0o600 });
  return {
    saved: cookies.length,
    encrypted: true,
    storageOrigin: storage ? storage.origin : null,
    localKeys: storage ? Object.keys(storage.local || {}).length : 0,
    idbDatabases: storage && Array.isArray(storage.idb) ? storage.idb.length : 0,
    cacheEntries: storage && Array.isArray(storage.caches)
      ? storage.caches.reduce((sum, cache) => sum + (cache.entries || []).length, 0)
      : 0,
    file,
  };
}

export async function loadProfile(session, name) {
  const file = path.join(PROFILE_DIR, `${safeName(name)}.json`);
  let payload;
  try {
    payload = decryptPayload(readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `快照读取失败（文件损坏或密钥不匹配）：${file}` };
  }
  const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
  await session.clearCookies();
  await session.setCookies(cookies);
  const storageRestored = await session.restoreStorage(payload.storage).catch(() => false);
  return {
    loaded: cookies.length,
    storageRestored: Boolean(storageRestored),
    storageOrigin: payload.storage ? payload.storage.origin : null,
    file,
    savedAt: payload.savedAt,
  };
}

export async function clearCookies(session) {
  await session.clearCookies();
  return { ok: true, cleared: 'all cookies' };
}

export async function clearSite(session) {
  const origin = await session.origin();
  if (!origin) return { error: '当前页面没有可识别的 origin' };
  await session.clearSiteData(origin);
  return { ok: true, origin };
}

export async function clearCache(session) {
  await session.clearCache();
  return { ok: true, cleared: 'browser cache' };
}
