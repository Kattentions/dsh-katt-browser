// Local static file server: the sidebar webview refuses file:// (ERR_FAILED), so local
// pages are served over http://127.0.0.1 instead.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

const servers = new Map();

const resolveInside = (root, requestPath) => {
  const decoded = decodeURIComponent(String(requestPath || '/').split('?')[0].split('#')[0]);
  const candidate = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
};

export function startServe(directory, port = 7810) {
  const root = path.resolve(String(directory || '.'));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return Promise.resolve({ error: `目录不存在：${root}` });
  }
  for (const [key, entry] of servers.entries()) {
    if (entry.root === root) return Promise.resolve({ url: entry.url, root, reused: true });
  }
  const actualPort = Number(port) || 7810;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const file = resolveInside(root, request.url || '/');
      if (!file) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('forbidden');
        return;
      }
      const target = existsSync(file) && statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
      if (!existsSync(target) || !statSync(target).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`not found: ${request.url}`);
        return;
      }
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      createReadStream(target).pipe(response);
    });
    server.on('error', (error) => resolve({ error: String(error && error.message ? error.message : error) }));
    server.listen(actualPort, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${actualPort}/`;
      servers.set(actualPort, { root, url, server });
      resolve({ url, root, port: actualPort });
    });
  });
}

/**
 * Serve one directory on the first free loopback port (7810–7899), reusing an
 * existing listener for the same root. Used when a file must be opened in the
 * sidebar browser without asking the user for a port.
 * @param {string} directory - directory to expose.
 * @returns {Promise<{ url?: string, root?: string, port?: number, reused?: boolean, error?: string }>}
 */
export async function startServeAuto(directory) {
  const root = path.resolve(String(directory || '.'));
  for (const [port, entry] of servers.entries()) {
    if (entry.root === root) return { url: entry.url, root, port };
  }
  let lastError = '';
  for (let candidate = 7810; candidate < 7900; candidate += 1) {
    if (servers.has(candidate)) continue;
    const result = await startServe(root, candidate);
    if (!result.error) return result;
    lastError = result.error;
  }
  return { error: '没有空闲的本地端口（7810-7899）：' + lastError };
}

export function stopServe(port) {  const key = Number(port);
  const entry = servers.get(key);
  if (!entry) return { error: `没有在运行的本地服务：${port}` };
  try { entry.server.close(); } catch {}
  servers.delete(key);
  return { ok: true, stopped: key };
}

export function listServe() {
  return {
    servers: [...servers.entries()].map(([port, entry]) => ({ port, root: entry.root, url: entry.url })),
  };
}

export function stopAllServe() {
  for (const [port] of servers) stopServe(port);
}
