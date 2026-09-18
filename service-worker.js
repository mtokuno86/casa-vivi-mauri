const CACHE_NAME = 'casa-vm-v33';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/modal.js',
  './js/recurrence.js',
  './js/members.js',
  './js/recipes.js',
  './js/recipeFacets.js',
  './js/mealPlanner.js',
  './js/stock.js',
  './js/shoppingList.js',
  './js/tasks.js',
  './js/auth.js',
  './js/calendar.js',
  './js/photos.js',
  './js/dashboard.js',
  './js/purchases.js',
  './js/priceInsights.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first para Google/Firebase e para config.js (muda durante o setup e
// não pode ficar preso em cache); cache-first para o resto do app shell.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Deixa passar direto (sem entrar no cache) qualquer requisição que não
  // seja do nosso próprio site — por exemplo "chrome-extension://..." de
  // extensões do navegador mexendo na página, ou métodos que não são GET
  // (a Cache API só aceita GET; tentar guardar POST/PUT gera erro). Sem
  // esse filtro, o navegador tenta cachear pedidos de extensões de terceiros
  // e a chamada falha com "Request scheme ... is unsupported".
  if (event.request.method !== 'GET' || !url.startsWith('http')) return;

  // BUG ENCONTRADO EM PRODUÇÃO (14/09/2026): antes, "isExternal" era uma
  // lista de domínios (googleapis.com, firebaseio.com, gstatic.com) — e
  // "cloudfunctions.net"/"run.app" (onde ficam TODAS as nossas Cloud
  // Functions, inclusive getGoogleAccessToken) não estavam nessa lista. Sem
  // querer, isso fazia o token de acesso do Google cair no ramo "cache-first"
  // lá embaixo: a primeira renovação bem-sucedida ficava guardada em cache
  // pra sempre, e toda chamada seguinte (mesmo dias depois) devolvia esse
  // MESMO token velho/vencido em 1ms — sem nunca consultar o Google de novo.
  // O app achava que tinha renovado com sucesso, mas estava reaplicando um
  // token morto, e por isso Agenda/Fotos falhavam com 401 mesmo "conectado".
  //
  // Correção: em vez de listar domínios (uma lista assim sempre esquece
  // algum, como aconteceu aqui), comparamos a ORIGEM da requisição com a
  // origem do próprio site. Qualquer coisa que não seja do nosso site
  // (Google, Firebase, nossas Cloud Functions, qualquer API futura) cai
  // automaticamente no caminho "nunca cachear" — só o HTML/CSS/JS do app em
  // si (mesma origem) usa cache-first.
  const isSameOrigin = url.startsWith(self.location.origin);
  const isConfig = url.includes('/js/config.js');

  if (!isSameOrigin || isConfig) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      });
    })
  );
});
