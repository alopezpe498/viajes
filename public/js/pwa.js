/**
 * public/js/pwa.js
 * -----------------------------------------------------------------------------
 * Registra el service worker. Nada más.
 *
 * Va aparte y no dentro de `app.js` porque no tiene que ver con la aplicación:
 * es fontanería del navegador. Si algún día hay que quitarlo, se quita esta
 * línea del <head> y no queda rastro.
 *
 * SE REGISTRA TARDE, en `load`. Registrar un service worker dispara la descarga
 * del armazón, y hacerlo mientras la página todavía está pintando le roba ancho
 * de banda a lo que la persona está esperando ver.
 *
 * SOLO EN HTTPS (o en localhost, que el navegador trata como seguro). Es
 * requisito del navegador, no una decisión nuestra.
 */
(() => {
  // ---------------------------------------------------------------------------
  // "¿De verdad se puede instalar?"
  //
  // Chrome dispara `beforeinstallprompt` cuando ha comprobado TODO lo suyo: que
  // hay manifest válido, iconos de 192 y 512, `display: standalone`, service
  // worker con manejador de `fetch` y origen seguro. Que salte es la única
  // confirmación de verdad; lo demás es mirar el código y suponer.
  //
  // Se escucha aquí, y no en una prueba, porque el evento salta muy pronto —a
  // veces antes de que termine de cargar la página— y hay que estar puesto
  // desde el principio. Deja una línea en la consola y el evento en
  // `window.__instalable`, que es lo que hay que mirar al desplegar.
  //
  // NO se llama a `prompt()`: instalar lo decide la persona desde el menú de
  // Chrome, no una ventana que salta sola nada más entrar.
  window.__instalable = null;
  window.addEventListener('beforeinstallprompt', (ev) => {
    window.__instalable = ev;
    console.log('[pwa] Chrome la da por instalable: aparece "Instalar app" en el menú.');
  });

  window.addEventListener('appinstalled', () => {
    console.log('[pwa] instalada.');
  });

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registro) => {
        console.log('[pwa] service worker registrado, ámbito:', registro.scope);
      })
      .catch((err) => {
        // Que falle no rompe nada: la app funciona igual, solo que no se puede
        // instalar. Por eso se avisa y se sigue.
        console.warn('[pwa] no se pudo registrar el service worker:', err.message);
      });
  });
})();
