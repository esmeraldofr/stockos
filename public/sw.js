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
    // Dados: INSTANTÂNEO SEMPRE (stale-while-revalidate). Com cache, a
    // resposta sai JÁ do aparelho — online e offline ficam iguais. A rede
    // corre em fundo; se os dados mudaram, o cache é actualizado e a app
    // é avisada (postMessage) para se refrescar.
    e.respondWith((async () => {
      const cached = await caches.match(req);
      // Cópia feita JÁ: o `cached` é entregue à página e um Response só se
      // lê uma vez — a comparação em fundo usa esta cópia independente.
      const cachedCopia = cached ? cached.clone() : null;
      const network = fetch(req)
        .then(async (resp) => {
          if (resp && resp.ok) {
            try {
              const novoTxt = await resp.clone().text();
              const antigoTxt = cachedCopia ? await cachedCopia.text() : null;
              const c = await caches.open(CACHE);
              await c.put(req, new Response(novoTxt, {
                status: 200,
                headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' }
              }));
              if (cached && antigoTxt !== novoTxt) {
                const clientes = await self.clients.matchAll();
                clientes.forEach((cl) => cl.postMessage({ tipo: 'dados-frescos', url: url.pathname + url.search }));
              }
            } catch (_) {}
          }
          return resp;
        })
        .catch(() => null);
      e.waitUntil(network); // a actualização em fundo completa mesmo após responder
      if (cached) return cached;
      // Sem cache exacto: espera pela rede; falhando, fallback progressivo —
      // sem «empresa=» (admin que usou o selector não perde o cache da
      // própria) → sem «loja=» (cache pré-multi-loja, só loja 1).
      const resp = await network;
      if (resp) return resp;
      if (url.searchParams.has('empresa')) {
        const semEmpresa = new URL(url.href);
        semEmpresa.searchParams.delete('empresa');
        const h2 = await caches.match(new Request(semEmpresa.href));
        if (h2) return h2;
      }
      if (url.searchParams.get('loja') === '1') {
        const antiga = new URL(url.href);
        antiga.searchParams.delete('loja');
        antiga.searchParams.delete('empresa');
        const hitAntigo = await caches.match(new Request(antiga.href));
        if (hitAntigo) return hitAntigo;
      }
      return new Response(
        JSON.stringify({ erro: 'Sem ligação e ainda sem dados guardados para este ecrã. Abre-o uma vez com rede.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    })());
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
