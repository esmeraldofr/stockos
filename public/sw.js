/* StockOS Service Worker — modo offline.
 *
 * Estratégias:
 *  - GET /api/*: REDE primeiro (dados frescos); sem rede, devolve o último
 *    valor conhecido do cache. Cada resposta boa actualiza o cache.
 *  - App shell e estáticos (/, index.html, …): CACHE primeiro (abre
 *    instantâneo e offline), com actualização em fundo — a versão nova
 *    entra no carregamento seguinte.
 *  - POST/PUT/DELETE nunca passam por aqui — offline, os pedidos ao balcão
 *    usam a fila local-first do próprio app.
 */
const CACHE = 'stockos-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) {
    // face-api.js e modelos de reconhecimento facial (CDN): CACHE primeiro —
    // depois da primeira utilização com rede, a página Presença abre e
    // reconhece rostos totalmente offline.
    if (url.hostname === 'cdn.jsdelivr.net') {
      e.respondWith(
        caches.match(req).then((hit) =>
          hit ||
          fetch(req).then((resp) => {
            if (resp && resp.ok) {
              const clone = resp.clone();
              caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
            }
            return resp;
          })
        )
      );
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Dados: rede primeiro; offline → último valor conhecido.
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return resp;
        })
        .catch(() =>
          caches.match(req).then((hit) =>
            hit ||
            new Response(
              JSON.stringify({ erro: 'Sem ligação e ainda sem dados guardados para este ecrã. Abre-o uma vez com rede.' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            )
          )
        )
    );
    return;
  }

  // App shell/estáticos: cache primeiro, actualiza em fundo.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return resp;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
