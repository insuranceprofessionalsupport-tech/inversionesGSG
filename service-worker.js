/**
 * Inversiones GSG — Service Worker v2.2
 *
 * REGLA DE ORO: cambia CACHE_VERSION con cada deploy para que
 * todos los usuarios vean la versión nueva en la próxima visita normal.
 *
 * Estrategias:
 *   index.html    → Network-first  (siempre intenta red primero)
 *   CDN libs      → Cache-first    (no cambian entre versiones)
 *   Supabase REST → Network-only   (datos en tiempo real, nunca caché)
 */
'use strict';

const CACHE_VERSION = 'gsg-v2.2';
const CACHE_CDN     = 'gsg-cdn-v2.2';

/* Librerías CDN que sí se cachean (no cambian entre versiones) */
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js'
];

/* ══ INSTALL ══════════════════════════════════════════
   Solo pre-cachea CDN libs. El index.html NO se
   pre-cachea aquí para que siempre se pida a la red.
══════════════════════════════════════════════════════ */
self.addEventListener('install', function (event) {
  console.log('[SW] Install — versión:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_CDN).then(function (cache) {
      return Promise.allSettled(
        CDN_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[SW] No se pudo pre-cachear:', url, err.message);
          });
        })
      );
    }).then(function () {
      /* Activar el nuevo SW inmediatamente sin esperar a que
         se cierren todas las pestañas del SW anterior */
      return self.skipWaiting();
    })
  );
});

/* ══ ACTIVATE ════════════════════════════════════════
   Elimina TODAS las cachés que no sean de esta versión.
   Después toma el control de todas las pestañas abiertas.
══════════════════════════════════════════════════════ */
self.addEventListener('activate', function (event) {
  console.log('[SW] Activate — limpiando cachés antiguas');
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            /* Borrar cualquier caché que no sea de la versión actual */
            return k !== CACHE_VERSION && k !== CACHE_CDN;
          })
          .map(function (k) {
            console.log('[SW] Borrando caché vieja:', k);
            return caches.delete(k);
          })
      );
    }).then(function () {
      /* Tomar control de todas las pestañas abiertas ahora mismo */
      return self.clients.claim();
    }).then(function () {
      /* Notificar a todos los clientes que recarguen para
         mostrar la versión más reciente */
      return self.clients.matchAll({ type: 'window' }).then(function (clients) {
        clients.forEach(function (client) {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
});

/* ══ FETCH ═══════════════════════════════════════════
   Estrategia diferenciada por tipo de recurso:
   1. Supabase API  → Network-only  (nunca desde caché)
   2. index.html    → Network-first (caché solo si offline)
   3. CDN libs      → Cache-first   (rápido, no cambian)
   4. Resto         → Network-first con fallback a caché
══════════════════════════════════════════════════════ */
self.addEventListener('fetch', function (event) {
  var url     = new URL(event.request.url);
  var isSupabase = url.hostname.includes('supabase.co');
  var isHTML     = url.pathname.endsWith('.html') || url.pathname === '/' ||
                   url.pathname.endsWith('/') || !url.pathname.includes('.');
  var isCDN      = CDN_URLS.some(function (u) { return event.request.url.startsWith(u.split('@')[0]); });
  var isFonts    = url.hostname.includes('fonts.g') || url.hostname.includes('fonts.g');

  /* 1 ── Supabase: siempre red, nunca caché */
  if (isSupabase) {
    event.respondWith(
      fetch(event.request).catch(function () {
        return new Response(
          JSON.stringify({ error: 'Sin conexión con Supabase.' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  /* 2 ── index.html: Network-first, caché solo offline */
  if (isHTML) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })   /* fuerza petición real */
        .then(function (res) {
          /* Guardar copia fresca en caché de versión actual */
          if (res && res.status === 200) {
            var clone = res.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(event.request, clone); });
          }
          return res;
        })
        .catch(function () {
          /* Sin red: servir desde caché si existe */
          return caches.match(event.request).then(function (cached) {
            return cached || new Response('<h1>Sin conexión</h1>', {
              headers: { 'Content-Type': 'text/html' }
            });
          });
        })
    );
    return;
  }

  /* 3 ── CDN libs: Cache-first (son inmutables por versión) */
  if (isCDN || isFonts) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) return cached;
        return fetch(event.request).then(function (res) {
          if (res && res.status === 200) {
            var clone = res.clone();
            caches.open(CACHE_CDN).then(function (c) { c.put(event.request, clone); });
          }
          return res;
        });
      })
    );
    return;
  }

  /* 4 ── Resto: Network-first con fallback */
  event.respondWith(
    fetch(event.request).then(function (res) {
      if (res && res.status === 200) {
        var clone = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(event.request, clone); });
      }
      return res;
    }).catch(function () {
      return caches.match(event.request);
    })
  );
});

/* ══ MENSAJE DESDE LA APP ════════════════════════════ */
self.addEventListener('message', function (event) {
  if (!event.data) return;

  /* La app pide verificar cobros de hoy */
  if (event.data.type === 'CHECK_COBROS_HOY') {
    verificarCobrosHoy(event.data.cuotas, event.data.clientes);
  }

  /* La app pide que el SW fuerce skipWaiting (para actualizaciones manuales) */
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ══ PUSH (notificaciones del servidor) ══════════════ */
self.addEventListener('push', function (event) {
  var data    = event.data ? event.data.json() : {};
  var title   = data.title || 'Inversiones GSG';
  var options = {
    body    : data.body  || 'Tienes cobros pendientes hoy.',
    icon    : data.icon  || './icons/icon-192.png',
    badge   : data.badge || './icons/badge-72.png',
    tag     : data.tag   || 'cobro-hoy',
    renotify: true,
    actions : [
      { action: 'ver',    title: 'Ver cobros' },
      { action: 'cerrar', title: 'Cerrar'     }
    ],
    data: { url: data.url || './#cobros' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* ══ CLICK EN NOTIFICACIÓN ═══════════════════════════ */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || './#cobros';
  if (event.action === 'cerrar') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        if (wins[i].url.includes(location.origin)) {
          wins[i].focus();
          wins[i].postMessage({ type: 'NAVIGATE', page: 'cobros' });
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

/* ══ VERIFICAR COBROS HOY (llamado por la app) ═══════ */
function verificarCobrosHoy(cuotas, clientes) {
  if (!cuotas || !clientes) return;
  var hoy        = new Date().toISOString().split('T')[0];
  var vencenHoy  = cuotas.filter(function (c) {
    return c.estado !== 'pagado' && c.fechaVence === hoy;
  });
  if (!vencenHoy.length) return;

  var nombres = vencenHoy.slice(0, 3).map(function (c) {
    var cl = clientes.find(function (x) { return x.id === c.clienteId; });
    return (cl ? cl.nombre : '?') + ' – ' + c.label;
  });
  var body = vencenHoy.length === 1
    ? nombres[0]
    : nombres.join('\n') + (vencenHoy.length > 3 ? '\n… y ' + (vencenHoy.length - 3) + ' más' : '');

  self.registration.showNotification('⏰ Cobros que vencen hoy — GSG', {
    body    : body,
    icon    : './icons/icon-192.png',
    badge   : './icons/badge-72.png',
    tag     : 'cobros-hoy-' + hoy,
    renotify: false,
    actions : [
      { action: 'ver',    title: 'Ver cobros' },
      { action: 'cerrar', title: 'Ignorar'    }
    ],
    data: { url: './#cobros' }
  });
}
