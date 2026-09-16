const http = require('node:http');

const html = (scriptPath) => `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'">
    <title>OmniBrowser POC fixture</title>
  </head>
  <body>
    <main id="status">Fixture ready</main>
    <script src="${scriptPath}"></script>
  </body>
</html>`;

const storageScript = `
const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('omnibrowser-poc', 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('tokens')) {
      request.result.createObjectStore('tokens');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const writeIndexedDb = async (token) => {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('tokens', 'readwrite');
    transaction.objectStore('tokens').put(token, 'shared');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
};

const readIndexedDb = async () => {
  const database = await openDatabase();
  const value = await new Promise((resolve, reject) => {
    const request = database.transaction('tokens', 'readonly').objectStore('tokens').get('shared');
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return value;
};

const readCookie = (name) => {
  const match = document.cookie.split('; ').find((part) => part.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
};

window.__storagePoc = {
  async write(token, cachePath) {
    document.cookie = 'persistentToken=' + encodeURIComponent(token) + '; Max-Age=86400; Path=/; SameSite=Lax';
    document.cookie = 'sessionToken=' + encodeURIComponent(token) + '; Path=/; SameSite=Lax';
    localStorage.setItem('omnibrowser-token', token);
    await writeIndexedDb(token);
    const cache = await caches.open('omnibrowser-poc-cache');
    await cache.put('/cache-storage-entry', new Response(token, { headers: { 'content-type': 'text/plain' } }));
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const httpCacheBody = await (await fetch(cachePath)).text();
    return { registrationScope: registration.scope, httpCacheBody };
  },
  async read() {
    const cache = await caches.open('omnibrowser-poc-cache');
    const cachedResponse = await cache.match('/cache-storage-entry');
    const registrations = await navigator.serviceWorker.getRegistrations();
    return {
      persistentCookie: readCookie('persistentToken'),
      sessionCookie: readCookie('sessionToken'),
      localStorage: localStorage.getItem('omnibrowser-token'),
      indexedDb: await readIndexedDb(),
      cacheStorage: cachedResponse ? await cachedResponse.text() : null,
      serviceWorkerScopes: registrations.map((registration) => registration.scope)
    };
  },
  async fetchHttpCache(cachePath) {
    return (await fetch(cachePath)).text();
  }
};
`;

const popupParentScript = `
const expectedOrigin = window.location.origin;
let popup = null;
const state = { opened: false, ready: false, pong: false, closed: false, cookie: null, targetReady: false };

window.addEventListener('message', (event) => {
  if (event.origin !== expectedOrigin || event.source !== popup || typeof event.data !== 'object' || event.data === null) return;
  if (event.data.type === 'popup-ready') {
    state.ready = true;
    state.cookie = typeof event.data.cookie === 'string' ? event.data.cookie : null;
    popup.postMessage({ type: 'parent-ping' }, expectedOrigin);
  }
  if (event.data.type === 'popup-pong') {
    state.pong = true;
  }
  if (event.data.type === 'target-ready') {
    state.targetReady = true;
  }
});

window.__popupPoc = {
  start(token) {
    document.cookie = 'popupShared=' + encodeURIComponent(token) + '; Max-Age=86400; Path=/; SameSite=Lax';
    popup = window.open('/popup-child.html', 'omnibrowser-auth-popup', 'width=480,height=360');
    state.opened = popup !== null;
    const timer = setInterval(() => {
      if (!popup || popup.closed) {
        state.closed = true;
        clearInterval(timer);
      }
    }, 30);
    return state.opened;
  },
  state() {
    return { ...state };
  },
  openTarget() {
    const link = document.createElement('a');
    link.href = '/popup-target.html';
    link.target = '_blank';
    link.rel = 'opener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
};
`;

const popupChildScript = `
const expectedOrigin = window.location.origin;
window.addEventListener('message', (event) => {
  if (event.origin !== expectedOrigin || event.source !== window.opener || typeof event.data !== 'object' || event.data === null) return;
  if (event.data.type === 'parent-ping') {
    window.opener.postMessage({ type: 'popup-pong' }, expectedOrigin);
    setTimeout(() => window.close(), 40);
  }
});
window.opener.postMessage({ type: 'popup-ready', cookie: document.cookie }, expectedOrigin);
`;

const popupTargetScript = `
const expectedOrigin = window.location.origin;
if (window.opener) window.opener.postMessage({ type: 'target-ready' }, expectedOrigin);
setTimeout(() => window.close(), 40);
`;

const resourceScript = `
const params = new URLSearchParams(location.search);
document.title = 'Resource fixture ' + (params.get('index') || '0');
let ticks = 0;
setInterval(() => { ticks += 1; document.body.dataset.ticks = String(ticks); }, 50);
window.__resourcePoc = {
  write(token) { localStorage.setItem('resource-token', token); return token; },
  read() { return localStorage.getItem('resource-token'); }
};
`;

function startFixtureServer() {
  const counters = new Map();
  const firstBodies = new Map();
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const send = (status, contentType, body, extraHeaders = {}) => {
      response.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extraHeaders
      });
      response.end(body);
    };

    if (requestUrl.pathname === '/storage.html') return send(200, 'text/html; charset=utf-8', html('/storage.js'));
    if (requestUrl.pathname === '/storage.js') return send(200, 'text/javascript; charset=utf-8', storageScript);
    if (requestUrl.pathname === '/popup-parent.html') return send(200, 'text/html; charset=utf-8', html('/popup-parent.js'));
    if (requestUrl.pathname === '/popup-parent.js') return send(200, 'text/javascript; charset=utf-8', popupParentScript);
    if (requestUrl.pathname === '/popup-child.html') return send(200, 'text/html; charset=utf-8', html('/popup-child.js'));
    if (requestUrl.pathname === '/popup-child.js') return send(200, 'text/javascript; charset=utf-8', popupChildScript);
    if (requestUrl.pathname === '/popup-target.html') return send(200, 'text/html; charset=utf-8', html('/popup-target.js'));
    if (requestUrl.pathname === '/popup-target.js') return send(200, 'text/javascript; charset=utf-8', popupTargetScript);
    if (requestUrl.pathname === '/resource.html') return send(200, 'text/html; charset=utf-8', html('/resource.js'));
    if (requestUrl.pathname === '/resource.js') return send(200, 'text/javascript; charset=utf-8', resourceScript);
    if (requestUrl.pathname === '/sw.js') {
      return send(200, 'text/javascript; charset=utf-8', "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));", {
        'service-worker-allowed': '/'
      });
    }
    if (requestUrl.pathname.startsWith('/http-cache/')) {
      const key = requestUrl.pathname;
      const nextCount = (counters.get(key) || 0) + 1;
      counters.set(key, nextCount);
      if (!firstBodies.has(key)) firstBodies.set(key, `${key.slice('/http-cache/'.length)}-network-response-${nextCount}`);
      return send(200, 'text/plain; charset=utf-8', `${key.slice('/http-cache/'.length)}-network-response-${nextCount}`, {
        'cache-control': 'public, max-age=86400'
      });
    }
    return send(404, 'text/plain; charset=utf-8', 'Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Fixture server did not expose a TCP port.'));
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        counters,
        firstBodies,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve()))
      });
    });
  });
}

module.exports = { startFixtureServer };
