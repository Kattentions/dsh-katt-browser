/**
 * Page-side storage scripts shared by the headless driver and the panel handoff.
 *
 * Kept in one file so both engines mirror the same stores: localStorage,
 * sessionStorage and IndexedDB. Cache storage is deliberately left out — PWA
 * caches are megabytes of base64 and carry no login material.
 *
 * Both expressions are self-contained strings: they are evaluated inside the
 * page, so they must not reference anything outside their own body.
 */

/** @param {number} idbLimit rows kept per object store. */
export function storageSnapshotExpression(idbLimit = 50) {
  const limit = Math.max(1, Number(idbLimit) || 50);
  return `(async () => {
    const idbLimit = ${limit};
    const out = { origin: location.origin, local: {}, session: {}, idb: [] };
    try { out.local = Object.fromEntries(Object.entries(localStorage).slice(0, 200)); } catch (error) {}
    try { out.session = Object.fromEntries(Object.entries(sessionStorage).slice(0, 200)); } catch (error) {}
    let databases = [];
    try { databases = await indexedDB.databases(); } catch (error) {}
    for (const info of databases.slice(0, 5)) {
      if (!info || !info.name) continue;
      const dump = await new Promise((resolve) => {
        let request;
        try { request = info.version ? indexedDB.open(info.name, info.version) : indexedDB.open(info.name); } catch (error) { resolve(null); return; }
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          const names = [...db.objectStoreNames];
          const result = { name: db.name, version: db.version, stores: [] };
          if (names.length === 0) { try { db.close(); } catch (error) {} resolve(result); return; }
          let remaining = names.length;
          const finish = () => { remaining -= 1; if (remaining === 0) { try { db.close(); } catch (error) {} resolve(result); } };
          for (const storeName of names) {
            const readAll = () => new Promise((res) => {
              const entries = [];
              try {
                const cursorRequest = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
                cursorRequest.onsuccess = (event) => {
                  const cursor = event.target.result;
                  if (!cursor) { res(entries); return; }
                  let value = null;
                  let key;
                  try { value = JSON.parse(JSON.stringify(cursor.value)); } catch (error) {}
                  try { key = JSON.parse(JSON.stringify(cursor.primaryKey)); } catch (error) {}
                  entries.push({ key, value });
                  if (entries.length >= idbLimit) { res(entries); return; }
                  cursor.continue();
                };
                cursorRequest.onerror = () => res(entries);
              } catch (error) { res(entries); }
            });
            readAll().then((entries) => {
              result.stores.push({ name: storeName, entries });
              finish();
            }).catch(() => finish());
          }
        };
      });
      if (dump) out.idb.push(dump);
    }
    return JSON.stringify(out);
  })()`;
}

/** @param {object} snapshot output of storageSnapshotExpression (already parsed). */
export function storageRestoreExpression(snapshot) {
  const payload = JSON.stringify({
    origin: (snapshot && snapshot.origin) || '',
    local: (snapshot && snapshot.local) || {},
    session: (snapshot && snapshot.session) || {},
    idb: (snapshot && Array.isArray(snapshot.idb)) ? snapshot.idb : [],
  });
  return `(async () => {
    const snapshot = ${payload};
    if (location.origin !== snapshot.origin) return false;
    try {
      for (const [key, value] of Object.entries(snapshot.local)) localStorage.setItem(key, String(value));
      for (const [key, value] of Object.entries(snapshot.session)) sessionStorage.setItem(key, String(value));
    } catch (error) {}
    for (const info of snapshot.idb) {
      if (!info || !info.name) continue;
      await new Promise((resolve) => {
        let request;
        try { request = info.version ? indexedDB.open(info.name, info.version) : indexedDB.open(info.name); } catch (error) { resolve(false); return; }
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of info.stores || []) {
            try { if (!db.objectStoreNames.contains(store.name)) db.createObjectStore(store.name); } catch (error) {}
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const stores = (info.stores || []).filter((store) => db.objectStoreNames.contains(store.name));
          if (stores.length === 0) { try { db.close(); } catch (error) {} resolve(true); return; }
          let remaining = stores.length;
          const finish = () => { remaining -= 1; if (remaining === 0) { try { db.close(); } catch (error) {} resolve(true); } };
          for (const store of stores) {
            try {
              const transaction = db.transaction(store.name, 'readwrite');
              const objectStore = transaction.objectStore(store.name);
              for (const entry of store.entries || []) {
                try {
                  if (entry.key === undefined || entry.key === null) objectStore.put(entry.value);
                  else objectStore.put(entry.value, entry.key);
                } catch (error) {}
              }
              transaction.oncomplete = finish;
              transaction.onerror = finish;
              transaction.onabort = finish;
            } catch (error) { finish(); }
          }
        };
      });
    }
    return true;
  })()`;
}
