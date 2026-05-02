/**
 * Inversiones GSG — Service Worker v2.0
 * Estrategia: Cache-first para assets estáticos, Network-first para API Supabase
 */
'use strict';

const CACHE_NAME    = 'gsg-v2.0';
const CACHE_STATIC  = 'gsg-static-v2.0';

/* Assets a pre-cachear en install */
const PRECACHE_URLS = [
  './',
  './index.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap'
];

/* ── INSTALL: pre-cachear assets críticos ── */
self.addEventListener('install', function(event) {
  console.log('[SW] Install — cacheando assets estáticos');
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(function(cache) {
        return Promise.allSettled(
          PRECACHE_URLS.map(function(url) {
            return cache.add(url).catch(function(err) {
              console.warn('[SW] No se pudo cachear:', url, err.message);
            });
          })
        );
      })
      .then(function() { return self.skipWaiting(); })
  );
});

/* ── ACTIVATE: limpiar caches viejas ── */
self.addEventListener('activate', function(event) {
  console.log('[SW] Activate — limpiando caches antiguas');
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(k) { return k !== CACHE_NAME && k !== CACHE_STATIC; })
          .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

/* ── FETCH: estrategia híbrida ── */
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // 1. Peticiones a Supabase → siempre Network (datos en tiempo real)
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return new Response(
          JSON.stringify({ error: 'Sin conexión. Datos en caché local.' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // 2. Peticiones a APIs externas → Network first con fallback a cache
  if (url.hostname !== location.hostname && !url.hostname.includes('fonts.g')) {
    event.respondWith(
      fetch(event.request)
        .then(function(res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(event.request, clone); });
          return res;
        })
        .catch(function() { return caches.match(event.request); })
    );
    return;
  }

  // 3. Assets propios → Cache first, red como fallback
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(res) {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        var clone = res.clone();
        caches.open(CACHE_STATIC).then(function(c) { c.put(event.request, clone); });
        return res;
      });
    })
  );
});

/* ══════════════════════════════════════════
   NOTIFICACIONES PUSH — Alertas de cobros
══════════════════════════════════════════ */

/* Escuchar mensajes desde la app principal */
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CHECK_COBROS_HOY') {
    verificarCobrosHoy(event.data.cuotas, event.data.clientes);
  }
});

/* Recibir push desde servidor (para push real con VAPID keys) */
self.addEventListener('push', function(event) {
  var data = event.data ? event.data.json() : {};
  var title   = data.title   || 'Inversiones GSG';
  var options = {
    body   : data.body    || 'Tienes cobros pendientes hoy.',
    icon   : data.icon    || './icons/icon-192.png',
    badge  : data.badge   || './icons/badge-72.png',
    tag    : data.tag     || 'cobro-hoy',
    renotify: true,
    actions: [
      { action: 'ver',    title: 'Ver cobros' },
      { action: 'cerrar', title: 'Cerrar'     }
    ],
    data: { url: data.url || './#cobros' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* Click en notificación */
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || './#cobros';
  if (event.action === 'cerrar') return;
  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(wins) {
      for (var i = 0; i < wins.length; i++) {
        if (wins[i].url.includes(location.origin)) {
          wins[i].focus();
          wins[i].postMessage({ type:'NAVIGATE', page:'cobros' });
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

/* Verificar cuotas que vencen hoy (llamado desde la app vía postMessage) */
function verificarCobrosHoy(cuotas, clientes) {
  if (!cuotas || !clientes) return;
  var hoy = new Date().toISOString().split('T')[0];
  var vencenHoy = cuotas.filter(function(c) {
    return c.estado !== 'pagado' && c.fechaVence === hoy;
  });
  if (!vencenHoy.length) return;

  var nombres = vencenHoy.slice(0, 3).map(function(c) {
    var cl = clientes.find(function(x) { return x.id === c.clienteId; });
    return (cl ? cl.nombre : '?') + ' – ' + c.label;
  });

  var body = vencenHoy.length === 1
    ? nombres[0]
    : nombres.join('\n') + (vencenHoy.length > 3 ? '\n… y ' + (vencenHoy.length - 3) + ' más' : '');

  self.registration.showNotification('⏰ Cobros que vencen hoy — GSG', {
    body   : body,
    icon   : './icons/icon-192.png',
    badge  : './icons/badge-72.png',
    tag    : 'cobros-hoy-' + hoy,
    renotify: false,
    actions: [
      { action:'ver',    title:'Ver cobros' },
      { action:'cerrar', title:'Ignorar'    }
    ],
    data: { url: './#cobros' }
  });
}
