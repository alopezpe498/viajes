/**
 * public/js/dosier.js
 * -----------------------------------------------------------------------------
 * La línea del dosier: el check de "viaje listo" y el menú del botón.
 *
 * El mismo código en "Mi ruta" y en el lienzo porque es el mismo control. Se
 * engancha por la clase del parcial, así que la pantalla que lo incluya lo tiene
 * funcionando sin hacer nada más.
 */
(() => {
  const linea = document.querySelector('.dosier-linea');
  if (!linea) return;

  const viajeId = linea.dataset.viaje;
  const check = document.getElementById('check-listo');
  const boton = document.getElementById('generar-dosier');
  const menu = document.getElementById('dosier-desplegable');
  const punto = document.getElementById('dosier-punto');
  const alerta = document.getElementById('dosier-falta');

  /** Aviso corto abajo que se va solo. Nada de alert(), que bloquea. */
  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 5000);
  }

  /** Deja la línea y el menú diciendo lo que hay. */
  function pintar(d) {
    document.getElementById('dosier-fecha').textContent = d.hay
      ? `Generado el ${d.generadoEnLargo}.`
      : 'Todavía no lo has generado.';

    document.getElementById('dosier-viejo').classList.toggle('oculto', !d.viejo);
    punto?.classList.toggle('oculto', !d.viejo);
    document.getElementById('dosier-hay').classList.toggle('oculto', !d.hay);
    document.getElementById('regenerar-texto').textContent = d.hay ? 'Regenerar' : 'Generar';
  }

  const cerrarMenu = () => {
    if (!menu) return;
    menu.hidden = true;
    boton?.setAttribute('aria-expanded', 'false');
  };

  // ===========================================================================
  // EL ⚠ DE LO QUE FALTA
  // ---------------------------------------------------------------------------
  // En escritorio se lee con el `title` al pasar por encima. En un móvil no hay
  // "pasar por encima", así que pulsarlo enseña lo mismo abajo.
  // ===========================================================================
  alerta?.addEventListener('click', () => {
    if (alerta.dataset.nota) avisar(alerta.dataset.nota);
  });

  // ===========================================================================
  // EL CHECK
  // ===========================================================================
  check?.addEventListener('click', async () => {
    const nuevo = check.getAttribute('aria-pressed') !== 'true';

    // Se pinta antes de que conteste el servidor: es un interruptor, y esperar
    // medio segundo a ver si se enciende lo hace sentir roto.
    check.setAttribute('aria-pressed', String(nuevo));
    check.classList.toggle('interruptor--si', nuevo);
    if (boton) {
      boton.disabled = !nuevo;
      boton.title = nuevo
        ? 'Ver, descargar o compartir el dosier del viaje'
        : 'Marca el viaje como listo para poder generar el dosier';
      if (!nuevo) cerrarMenu();
    }

    try {
      const r = await fetch(`/api/viaje/${viajeId}/listo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ listo: nuevo }),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
      pintar(datos.dosier);
    } catch (err) {
      console.error('[dosier] no se pudo guardar el check:', err);
      // Se deshace: mejor volver a lo que había que mentir sobre el estado.
      check.setAttribute('aria-pressed', String(!nuevo));
      check.classList.toggle('interruptor--si', !nuevo);
      if (boton) boton.disabled = nuevo;
      avisar(err.message);
    }
  });

  // ===========================================================================
  // EL MENÚ
  // ===========================================================================
  boton?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const abierto = boton.getAttribute('aria-expanded') === 'true';
    menu.hidden = abierto;
    boton.setAttribute('aria-expanded', String(!abierto));

    // Al ABRIR el menú se va trayendo el ZIP, para que cuando se pulse
    // "Compartir" ya esté aquí y no haya que esperar a nada. Esperar dentro del
    // manejador del clic es justo lo que rompía el compartir en el móvil.
    if (!abierto) precargarZip();
  });

  menu?.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', cerrarMenu);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') cerrarMenu();
  });

  // ===========================================================================
  // GENERAR
  // ===========================================================================
  const regenerar = document.getElementById('dosier-regenerar');

  regenerar?.addEventListener('click', async () => {
    regenerar.disabled = true;
    const texto = document.getElementById('regenerar-texto');
    const antes = texto.textContent;
    texto.textContent = 'Generando…';
    regenerar.querySelector('i').className = 'ti ti-loader-2 girando';

    try {
      const r = await fetch(`/api/viaje/${viajeId}/dosier`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      pintar(datos.dosier);

      // El ZIP que hubiera preparado es del dosier anterior: fuera, y se trae
      // el nuevo para que "Compartir" siga sin tener que esperar.
      zipListo = null;
      precargarZip();

      avisar(
        `Dosier listo · ${datos.tamano}` +
          (datos.adjuntos ? ` · ${datos.adjuntos} adjuntos` : '') +
          (datos.adjuntosOmitidos ? ` (${datos.adjuntosOmitidos} sin encontrar)` : '')
      );
    } catch (err) {
      console.error('[dosier] no se pudo generar:', err);
      avisar(err.message);
    } finally {
      texto.textContent = antes;
      regenerar.querySelector('i').className = 'ti ti-refresh';
      regenerar.disabled = false;
    }
  });

  // ===========================================================================
  // COMPARTIR
  // ---------------------------------------------------------------------------
  // La Web Share API del sistema, que ya ofrece WhatsApp, correo, AirDrop y lo
  // que haya instalado. Nada de integraciones propias con cada aplicación.
  //
  // EL ORDEN IMPORTA, Y ESTE ERA EL FALLO. `navigator.share()` exige una
  // "activación transitoria": el permiso que da el navegador durante unos
  // segundos después de que TÚ toques algo. Antes se hacía `await fetch(zip)`
  // dentro del manejador y solo después se llamaba a share: para cuando el ZIP
  // llegaba, la activación ya había caducado, así que en el móvil —donde la API
  // sí existe— se caía igualmente al plan de descargar.
  //
  // Así que el ZIP se pide ANTES, al abrir el menú, y el clic de "Compartir" no
  // espera a nada: llama a share como primera cosa, sin un solo `await` por
  // delante (de ahí el `.then()` en vez de `await`, que dejaría el resto del
  // manejador para el siguiente turno y volvería a perder la activación).
  //
  // TRES ESCALONES, de mejor a peor:
  //   1. Compartir el ZIP.
  //   2. Si el navegador no admite ESE archivo, compartir el texto y descargar
  //      el ZIP aparte: al menos el mensaje sale del selector del sistema.
  //   3. Si no hay API, descargar y decir qué hacer.
  // ===========================================================================
  const compartir = document.getElementById('dosier-compartir');
  const urlZip = `/viaje/${viajeId}/dosier/descargar`;

  /** El ZIP ya traído, listo para compartirse sin esperas. */
  let zipListo = null;
  let trayendoZip = null;

  /**
   * Trae el ZIP y lo deja preparado. Se llama al abrir el menú, no al pulsar
   * "Compartir": para entonces ya tiene que estar aquí.
   */
  function precargarZip() {
    if (zipListo || trayendoZip) return trayendoZip;

    // Mientras viene, el botón lo dice. Si no, en una conexión lenta se podría
    // pulsar "Compartir" antes de que llegue y acabaríamos compartiendo solo el
    // texto sin que se entienda por qué.
    marcarPreparando(true);

    trayendoZip = fetch(urlZip)
      .then(async (r) => {
        if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
        const datos = await r.blob();
        const nombre =
          (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] ?? 'dosier.zip';
        zipListo = new File([datos], nombre, { type: 'application/zip' });
        console.log(`[dosier] ZIP preparado para compartir: ${nombre} (${zipListo.size} bytes).`);
        return zipListo;
      })
      .catch((err) => {
        console.warn('[dosier] no se pudo precargar el ZIP:', err.message);
        return null;
      })
      .finally(() => {
        trayendoZip = null;
        marcarPreparando(false);
      });

    return trayendoZip;
  }

  /**
   * El botón de compartir, mientras el ZIP está de camino.
   *
   * Deshabilitado y con el icono girando. Normalmente ni se ve: el ZIP llega
   * mucho antes de que a nadie le dé tiempo a bajar el dedo. Pero si la
   * conexión va lenta, más vale un botón que dice "Preparando…" que uno que
   * comparte a medias.
   */
  function marcarPreparando(si) {
    const boton = document.getElementById('dosier-compartir');
    if (!boton) return;
    const texto = boton.querySelector('span');
    const icono = boton.querySelector('i');
    boton.disabled = si;
    if (texto) texto.textContent = si ? 'Preparando…' : 'Compartir';
    if (icono) icono.className = si ? 'ti ti-loader-2 girando' : 'ti ti-share';
  }

  /** Descarga el ZIP a pelo. Es el último recurso, y siempre funciona. */
  function bajarZip() {
    const a = document.createElement('a');
    a.href = urlZip;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * Por qué se ha caído al plan B.
   *
   * EL DETALLE TÉCNICO VA AL LOG, NO A LA PANTALLA. Un "NotAllowedError:
   * Permission denied" no le dice nada a nadie que solo quiera mandar su dosier
   * por WhatsApp; en pantalla va lo único accionable —que el ZIP está
   * descargado— y en la consola queda lo que hace falta para diagnosticar.
   */
  function porQue(motivo, detalle) {
    console.warn('[dosier] compartir:', detalle ? `${motivo} — ${detalle}` : motivo);
    avisar('No se pudo abrir el menú de compartir. El ZIP está descargado: envíalo desde tu gestor de archivos.');
  }

  compartir?.addEventListener('click', () => {
    // --- El ZIP todavía no está: NO se comparte -----------------------------
    //
    // Con el botón deshabilitado esto casi no puede pasar, pero si pasara, lo
    // que NO se hace es esperar al ZIP y llamar a share después: para entonces
    // ya no habría gesto y volveríamos al mismo error. Se avisa, se sigue
    // trayendo y el botón se habilita para un segundo toque, que sí tendrá su
    // gesto propio.
    if (!zipListo) {
      precargarZip()?.then(() => avisar('Ya está listo: vuelve a pulsar Compartir.'));
      avisar('Preparando el dosier…');
      return;
    }

    // --- Escalón 3: aquí no hay nada que hacer -----------------------------
    if (!navigator.share) {
      bajarZip();
      console.warn('[dosier] compartir: este navegador no trae la Web Share API.');
      avisar('Este navegador no sabe compartir. El ZIP está descargado: envíalo desde tu gestor de archivos.');
      return;
    }

    const puedeConArchivos =
      Boolean(navigator.canShare) && navigator.canShare({ files: [zipListo] });

    // --- Escalón 1: el ZIP, que es lo que se quiere compartir --------------
    if (puedeConArchivos) {
      // SIN await por delante: la activación del usuario sigue viva.
      navigator
        .share({ files: [zipListo], title: document.title, text: 'El dosier de mi viaje' })
        .then(() => console.log('[dosier] compartido con archivo.'))
        .catch((err) => {
          // Cancelar el selector del sistema lanza AbortError: no es un fallo.
          if (err?.name === 'AbortError') {
            console.log('[dosier] compartir cancelado por el usuario.');
            return;
          }
          bajarZip();
          porQue('share() falló con el archivo', `${err?.name ?? 'Error'}: ${err?.message ?? err}`);
        });
      return;
    }

    // --- Escalón 2: compartir el texto y bajar el ZIP aparte ---------------
    //
    // Pasa cuando el navegador trae la API pero no traga ESTE archivo: Chrome
    // de escritorio no comparte archivos, y varios navegadores solo admiten
    // ciertos tipos (un .zip no siempre entra). El texto sí sale por el
    // selector del sistema, y el ZIP se descarga para adjuntarlo a mano.
    const motivo = !navigator.canShare
      ? 'este navegador no tiene canShare()'
      : 'canShare({files}) dijo que no con un application/zip';

    const url = location.origin + urlZip;
    navigator
      .share({ title: document.title, text: `Dosier del viaje — ${document.title}`, url })
      .then(() => {
        bajarZip();
        console.log(`[dosier] compartido solo el texto (${motivo}). ZIP descargado aparte.`);
        avisar('Compartido el enlace. El ZIP se ha descargado aparte para que lo adjuntes.');
      })
      .catch((err) => {
        if (err?.name === 'AbortError') {
          console.log('[dosier] compartir cancelado por el usuario.');
          return;
        }
        bajarZip();
        porQue(`sin compartir (${motivo})`, `${err?.name ?? 'Error'}: ${err?.message ?? err}`);
      });
  });

})();
