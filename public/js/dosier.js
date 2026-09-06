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
  // Hay dos motivos por los que puede no funcionar y los dos son normales:
  // Chrome de escritorio no comparte archivos, y algunos navegadores no traen
  // la API. En los dos casos se descarga el ZIP y se dice qué hacer con él, que
  // es lo único útil que se puede ofrecer.
  // ===========================================================================
  const compartir = document.getElementById('dosier-compartir');

  compartir?.addEventListener('click', async () => {
    const url = `/viaje/${viajeId}/dosier/descargar`;

    const bajar = (motivo) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      avisar(`${motivo} Descargado: compártelo desde tu gestor de archivos.`);
    };

    if (!navigator.canShare || !navigator.share) {
      bajar('Este navegador no sabe compartir archivos.');
      return;
    }

    compartir.disabled = true;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('No se pudo leer el dosier.');
      const datos = await r.blob();

      const nombre = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1]
        ?? 'dosier.zip';
      const archivo = new File([datos], nombre, { type: 'application/zip' });

      if (!navigator.canShare({ files: [archivo] })) {
        bajar('Este navegador no permite compartir archivos.');
        return;
      }

      await navigator.share({ files: [archivo], title: document.title });
    } catch (err) {
      // Cancelar el diálogo del sistema lanza AbortError: eso no es un fallo.
      if (err?.name === 'AbortError') return;
      console.error('[dosier] no se pudo compartir:', err);
      bajar('No se pudo abrir el menú de compartir.');
    } finally {
      compartir.disabled = false;
    }
  });
})();
