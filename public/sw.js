/**
 * public/sw.js
 * -----------------------------------------------------------------------------
 * El service worker. Está aquí para que la app se pueda INSTALAR, no para
 * convertirla en una app offline.
 *
 * ESTA APP VIVE DE DATOS VIVOS. Los precios de los vuelos, las plazas de un
 * hotel, los horarios de un autobús: todo lo interesante que enseña esta
 * pantalla puede haber cambiado desde ayer. Un service worker alegre que sirva
 * lo primero que tenga en caché convierte una herramienta de planificar en una
 * fuente de datos viejos sin avisar, que es peor que no tener nada.
 *
 * Así que la regla es siempre la misma: PRIMERO LA RED. La caché solo entra
 * cuando la red ha fallado de verdad, y entonces es un apaño de emergencia —el
 * metro, un pueblo sin cobertura, el avión— y no el camino normal.
 *
 * QUÉ SE CACHEA Y QUÉ NO
 *
 *   Estáticos (css, js, iconos)   Caché primero. Son míos, los versiono yo, y
 *                                 no cambian sin que cambie VERSION.
 *   Páginas                       Red primero, caché de respaldo. Offline se ve
 *                                 lo último que se vio, que para mirar el
 *                                 dosier en la calle es justo lo que hace falta.
 *   API (GET)                     Red primero, caché de respaldo.
 *   Búsquedas y consultas de IA   NUNCA. Se explica abajo.
 *   POST, PUT, DELETE             NUNCA. Ni se tocan.
 *
 * Para publicar cambios, subir VERSION. Al activarse borra las cachés viejas.
 */

const VERSION = 'v18';
const CACHE_ESTATICA = `viajes-estatica-${VERSION}`;
const CACHE_VIVA = `viajes-viva-${VERSION}`;

/**
 * El armazón: lo que hace falta para que la app pinte algo.
 *
 * Deliberadamente corto. Aquí NO va ninguna página: una página lleva datos del
 * viaje dentro, y precacharla sería congelar el viaje del día que se instaló.
 */
const ESTATICOS = [
  '/css/estilo.css',
  '/js/app.js',
  '/js/pwa.js',
  '/js/mapa-teselas.js',
  '/manifest.webmanifest',
  '/icons/icono-192.png',
  '/icons/icono-512.png',
  '/icons/icono-maskable-192.png',
  '/icons/icono-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

/**
 * Lo que NO se guarda nunca, aunque sea un GET que responda 200.
 *
 * Son las consultas que cuestan dinero o que dependen del momento: buscar
 * vuelos, preguntarle a la IA, calcular un traslado, mirar el estado de un
 * trabajo de la cola. Servir de caché el estado de un trabajo es lo peor que
 * podría hacer este archivo: la pantalla se quedaría con un "buscando…" eterno
 * porque nunca vería que ya terminó.
 */
const NUNCA = [
  '/estado',
  '/buscar',
  '/detalles',
  '/hueco',
  '/situar',
  '/dosier/descargar',
  '/adjuntos',
];

/**
 * DOS CLASES DE ESTÁTICO, Y NO SE TRATAN IGUAL.
 *
 * El CSS y el JS CAMBIAN con cada despliegue y son los que rompen la página si
 * se quedan viejos: el HTML llega fresco estrenando clases y el CSS cacheado no
 * las tiene, así que media pantalla desaparece. Esos van a la red primero.
 *
 * Las imágenes, los iconos y las fuentes no cambian casi nunca y pesan. Esas sí
 * se sirven de la caché, que es de lo que va una PWA.
 */
const esCodigo = (url) =>
  /\.(css|js)$/i.test(url.pathname) || url.pathname === '/manifest.webmanifest';

const esPeso = (url) => /\.(png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(url.pathname);

const esDeNunca = (url) => NUNCA.some((t) => url.pathname.includes(t));

// =============================================================================
// INSTALAR Y ACTIVAR
// =============================================================================
self.addEventListener('install', (ev) => {
  ev.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_ESTATICA);
      // Uno a uno y sin rendirse: si un archivo falla —porque se renombró y se
      // me olvidó actualizar la lista— el resto se guarda igual. Con
      // `addAll` un solo 404 tumba toda la instalación.
      await Promise.all(
        ESTATICOS.map((ruta) =>
          cache.add(ruta).catch((err) => console.warn('[sw] no pude precachear', ruta, err))
        )
      );
      // Que la versión nueva entre en cuanto esté, sin esperar a que se cierren
      // todas las pestañas. Es una app de uso personal: la alternativa es que
      // un arreglo tarde días en verse.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    (async () => {
      // Fuera las cachés de versiones anteriores. Sin esto se van acumulando
      // copias de cada despliegue.
      const nombres = await caches.keys();
      await Promise.all(
        nombres
          .filter((n) => n.startsWith('viajes-') && n !== CACHE_ESTATICA && n !== CACHE_VIVA)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// =============================================================================
// LAS PETICIONES
// =============================================================================
self.addEventListener('fetch', (ev) => {
  const { request } = ev;

  // NADA QUE NO SEA GET PASA POR AQUÍ. Guardar un POST no tiene sentido —no es
  // idempotente— y responder uno de caché sería inventarse que algo se guardó.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Solo lo de esta casa. Los iconos de Tabler o las fotos de Civitatis vienen
  // de fuera y se quedan como estaban.
  if (url.origin !== self.location.origin) return;

  if (esDeNunca(url)) return;                       // ni mirar

  // Lo que pesa y no cambia, de la caché. Lo que cambia, de la red.
  if (esPeso(url)) return ev.respondWith(deCacheOSiNoDeRed(request));
  if (esCodigo(url)) return ev.respondWith(deRedOSiNoDeCache(request, CACHE_ESTATICA));

  ev.respondWith(deRedOSiNoDeCache(request));
});

/**
 * De la caché, y si no está, de la red. Solo para lo que no cambia.
 *
 * AQUÍ ESTABAN TAMBIÉN EL CSS Y EL JS, y era un error. La caché lleva la
 * versión en el nombre, así que en teoría bastaba con subir `VERSION` en cada
 * despliegue. En la práctica se olvida —se me olvidó a mí varias veces— y
 * entonces el navegador se queda con un CSS de hace tres semanas para siempre,
 * mientras el HTML llega fresco. El resultado no es "se ve algo viejo": es que
 * lo nuevo NO SE VE, porque sus reglas no existen en el CSS cacheado.
 *
 * Una regla que hay que recordar en cada despliegue no es una regla, es una
 * trampa. Ahora esto solo lo usan las imágenes y las fuentes, que cambian de
 * año en año.
 */
async function deCacheOSiNoDeRed(request) {
  const guardado = await caches.match(request);
  if (guardado) return guardado;

  const respuesta = await fetch(request);
  if (respuesta.ok) {
    const cache = await caches.open(CACHE_ESTATICA);
    cache.put(request, respuesta.clone());
  }
  return respuesta;
}

/**
 * Páginas, CSS y JS: LA RED PRIMERO, siempre.
 *
 * Solo si la red falla de verdad —sin cobertura, servidor caído— se mira la
 * caché. Y si tampoco hay nada guardado, se contesta con una página que dice
 * claramente que eso es lo último que se vio y que hace falta conexión, en vez
 * del error del navegador.
 */
async function deRedOSiNoDeCache(request, dondeGuardar = CACHE_VIVA) {
  try {
    const respuesta = await fetch(request);

    // Se guarda solo lo que salió bien. Un 404 o un 500 en caché sería un
    // fantasma difícil de encontrar.
    if (respuesta.ok && respuesta.type === 'basic') {
      const cache = await caches.open(dondeGuardar);
      cache.put(request, respuesta.clone());
    }
    return respuesta;
  } catch {
    const guardado = await caches.match(request);
    if (guardado) return guardado;

    // Sin red y sin copia. Para una navegación se contesta algo legible; para
    // una llamada de la API, un 503 honesto que la pantalla ya sabe tratar.
    if (request.mode === 'navigate') return paginaSinConexion();
    return new Response(JSON.stringify({ error: 'Sin conexión.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Lo mínimo, con la cara de la app y sin pedirle nada a la red. */
function paginaSinConexion() {
  return new Response(
    `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1B7FA6">
  <title>Sin conexión</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center;
           background:#F4F8FA; color:#12303E; text-align:center; padding:24px;
           font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
    h1 { font-size:20px; margin:0 0 8px; }
    p { color:#5E7A87; margin:0 0 18px; max-width:34ch; line-height:1.5; }
    button { border:0; border-radius:999px; background:#1B7FA6; color:#fff;
             padding:12px 24px; font:inherit; font-weight:650; cursor:pointer; }
  </style>
</head>
<body>
  <div>
    <h1>Sin conexión</h1>
    <p>Esta pantalla no la tengo guardada. En cuanto vuelva la red, aquí está todo.</p>
    <button onclick="location.reload()">Reintentar</button>
  </div>
</body>
</html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
