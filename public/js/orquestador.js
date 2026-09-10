/**
 * public/js/orquestador.js
 * -----------------------------------------------------------------------------
 * Las dos pantallas del orquestador: el progreso de un viaje y sus ajustes.
 *
 * Van en el mismo archivo porque son dos cosas pequeñas de la misma familia.
 * Cada bloque se activa solo si encuentra lo suyo en el HTML —el progreso mira
 * el `data-viaje`, los ajustes miran el aviso—, así que cargarlo en las dos no
 * cuesta nada y ninguno estorba al otro.
 */
(() => {
  'use strict';

  // ===========================================================================
  // 1) EL PROGRESO
  // ---------------------------------------------------------------------------
  // Mientras algo esté en marcha se pregunta cada pocos segundos y se repinta.
  // Cuando no queda nada trabajando se recarga UNA vez y el sondeo se apaga
  // solo: dejarlo preguntando para siempre a un trabajo terminado es lo que le
  // pasaba a otras pantallas de esta casa antes de unificar el sondeo.
  // ===========================================================================
  const panel = document.querySelector('.orquestador[data-viaje]');
  if (panel) {
    const viajeId = panel.dataset.viaje;
    const CADA = 2500;

    const ICONO = {
      pendiente: 'ti-circle',
      en_curso: 'ti-loader-2',
      hecho: 'ti-circle-check',
      con_huecos: 'ti-alert-circle',
      error: 'ti-circle-x',
    };

    const esc = (t) =>
      String(t ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
      );

    const pintar = (datos) => {
      const relleno = document.getElementById('orq-relleno');
      if (relleno) relleno.style.width = `${datos.porcentaje}%`;

      // La caja de parada: se esconde en cuanto deja de haber algo corriendo, y
      // mientras tanto dice si ya se ha pedido parar. Entre que se pulsa y que
      // el worker llega a su punto de control pueden pasar segundos, y sin esto
      // parece que el botón no ha hecho nada.
      const caja = document.getElementById('orq-parada');
      if (caja) caja.hidden = !datos.trabajando;

      const nota = document.getElementById('orq-parada-nota');
      if (nota) {
        nota.textContent =
          datos.parando === 'limpia'
            ? 'Parando en cuanto termine el paso que tiene entre manos…'
            : datos.parando === 'abortar'
              ? 'Abortando y limpiando lo que quedó a medias…'
              : '«Parar» acaba el paso en marcha y lo deja ahí. «Abortar ya» corta en seco.';
      }

      const bajada = document.getElementById('orq-bajada');
      if (bajada) {
        bajada.textContent = datos.trabajando
          ? `Voy por la fase ${Math.min(datos.resueltas + 1, datos.total)} de ${datos.total}. ` +
            'Puedes cerrar esta pantalla: sigue en segundo plano.'
          : datos.terminado
            ? 'Ya está. Repasa lo que ha quedado y ajusta lo que quieras.'
            : 'Todavía no ha empezado.';
      }

      for (const f of datos.fases) {
        const li = panel.querySelector(`[data-fase="${f.clave}"]`);
        if (!li) continue;

        li.className = `orq-fase orq-fase--${f.estado}`;
        const marca = li.querySelector('.orq-fase__marca i');
        if (marca) {
          marca.className = `ti ${ICONO[f.estado]} ${f.estado === 'en_curso' ? 'orq-gira' : ''}`;
        }
        const estado = li.querySelector('.orq-fase__estado');
        if (estado) estado.textContent = f.nombreEstado;

        // El registro crece línea a línea; se repinta entero porque son unas
        // pocas frases y comparar cuál es nueva costaría más que rehacerlo.
        //
        // Cada línea puede traer su etiqueta de origen, así que esto ya no es un
        // <pre> con texto: es una lista, y la etiqueta va dentro de su línea.
        let log = li.querySelector('.orq-log');
        if (f.lineas && f.lineas.length) {
          if (!log) {
            log = document.createElement('ol');
            log.className = 'orq-log';
            li.querySelector('.orq-fase__explica').after(log);
          }
          log.innerHTML = f.lineas
            .map(
              (l) =>
                `<li class="orq-log__linea">${esc(l.texto)}` +
                (l.origen
                  ? `<span class="orq-origen orq-origen--${esc(l.origen)}">${esc(l.nombreOrigen)}</span>`
                  : '') +
                '</li>'
            )
            .join('');
        } else if (log) {
          log.remove();
        }

        let huecos = li.querySelector('.orq-fase__huecos');
        if (f.huecos.length) {
          if (!huecos) {
            huecos = document.createElement('ul');
            huecos.className = 'orq-fase__huecos';
            li.querySelector('.orq-fase__cuerpo').append(huecos);
          }
          huecos.innerHTML = f.huecos
            .map((h) => `<li><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${esc(h)}</li>`)
            .join('');
        } else if (huecos) {
          huecos.remove();
        }
      }
    };

    // =========================================================================
    // PARAR Y ABORTAR
    // -------------------------------------------------------------------------
    // El de abortar pregunta antes, y no por cortesía: corta una llamada a
    // mitad y después hay que barrer lo que quedó escrito. El otro no pregunta
    // porque no rompe nada — como mucho, esperas unos segundos de más.
    // =========================================================================
    const pedirParada = async (modo, boton) => {
      const nota = document.getElementById('orq-parada-nota');
      const otros = [
        document.getElementById('orq-parar'),
        document.getElementById('orq-abortar'),
      ];
      for (const b of otros) if (b) b.disabled = true;
      if (nota) nota.textContent = modo === 'abortar' ? 'Cortando…' : 'Pidiendo la parada…';

      try {
        const r = await fetch(`/viajes/${viajeId}/orquestador/parar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modo }),
        });
        const cuerpo = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cuerpo.error || `El servidor respondió ${r.status}`);
        if (nota) nota.textContent = cuerpo.mensaje ?? 'Hecho.';
      } catch (err) {
        if (nota) nota.textContent = `No se pudo parar: ${err.message}`;
        for (const b of otros) if (b) b.disabled = false;
      }
    };

    document
      .getElementById('orq-parar')
      ?.addEventListener('click', (ev) => pedirParada('limpia', ev.currentTarget));

    document.getElementById('orq-abortar')?.addEventListener('click', (ev) => {
      if (!confirm('¿Seguro? Se cancela todo de inmediato.')) return;
      pedirParada('abortar', ev.currentTarget);
    });

    document.getElementById('orq-reanudar')?.addEventListener('click', async (ev) => {
      const boton = ev.currentTarget;
      const nota = document.getElementById('orq-reanudar-nota');
      boton.disabled = true;
      if (nota) nota.textContent = 'Reanudando…';
      try {
        const r = await fetch(`/viajes/${viajeId}/orquestador/reanudar`, { method: 'POST' });
        const cuerpo = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cuerpo.error || `El servidor respondió ${r.status}`);
        location.reload();
      } catch (err) {
        if (nota) nota.textContent = err.message;
        boton.disabled = false;
      }
    });

    if (panel.dataset.trabajando) {
      const reloj = setInterval(async () => {
        try {
          const r = await fetch(`/viajes/${viajeId}/orquestador/estado`, {
            headers: { Accept: 'application/json' },
          });
          if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
          const datos = await r.json();
          pintar(datos);

          // Terminado: una recarga para que salga el resumen de huecos y el
          // botón en primario, y a callar.
          if (!datos.trabajando) {
            clearInterval(reloj);
            location.reload();
          }
        } catch (err) {
          // Un fallo suelto de red no puede cortar el sondeo: el trabajo sigue
          // corriendo en el servidor aunque esta petición se haya perdido.
          console.warn('[orquestador] no pude preguntar por el progreso:', err.message);
        }
      }, CADA);
    }
  }

  // ===========================================================================
  // 2) LOS AJUSTES: números y prompts, sección por sección
  // ---------------------------------------------------------------------------
  // Los dos vivían en pantallas distintas y cada uno tenía su bloque, su aviso y
  // su `querySelector`. Ahora conviven en la misma página, con una lista de
  // parámetros por sección, así que nada puede ir buscando "el" primero que
  // encuentre: se escucha en la raíz y se resuelve por el elemento pulsado.
  //
  // Los números se guardan al salir del campo y los prompts con su botón. No es
  // una incoherencia: un número se cambia de un teclazo y confirmarlo sobra; un
  // prompt es un texto largo que se escribe a ratos, y guardarlo solo mientras
  // alguien lo redacta daría sustos.
  // ===========================================================================
  const ajustes = document.querySelector('.orquestador');
  const aviso = document.querySelector('[data-aviso]');

  if (ajustes && aviso) {
    let borrarAviso = null;
    const decir = (texto, malo = false) => {
      aviso.textContent = texto ?? '';
      aviso.hidden = !texto;
      aviso.classList.toggle('orq-aviso--malo', Boolean(malo));
      clearTimeout(borrarAviso);
      if (texto && !malo) borrarAviso = setTimeout(() => { aviso.hidden = true; }, 2000);
    };

    /** Deja la fila de un parámetro con la cara que le toca. */
    const refrescarParametro = (fila, datos) => {
      fila.classList.toggle('orq-parametro--tocado', !datos.esDeFabrica);
      const boton = fila.querySelector('[data-restaurar]');
      if (boton) boton.hidden = datos.esDeFabrica;
      const campo = fila.querySelector('[data-valor]');
      if (campo) campo.value = datos.valor;
    };

    /** Y lo mismo con la caja de un prompt. */
    const refrescarPrompt = (caja, datos) => {
      caja.classList.toggle('orq-prompt--tocado', !datos.esDeFabrica);
      const boton = caja.querySelector('[data-restaurar-prompt]');
      if (boton) boton.hidden = datos.esDeFabrica;
      const cuando = caja.querySelector('.orq-prompt__cuando');
      if (cuando) cuando.textContent = datos.esDeFabrica ? 'Como vino de fábrica' : 'Editado ahora mismo';
      const texto = caja.querySelector('[data-texto]');
      if (texto) texto.value = datos.prompt_actual;
    };

    /** Una llamada al servidor con el mismo trato para todas: falla o repinta. */
    const mandar = async (url, cuerpo) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: cuerpo
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
      const datos = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
      return datos;
    };

    // --- Un número, al salir del campo ------------------------------------
    ajustes.addEventListener('change', async (ev) => {
      const campo = ev.target.closest('[data-valor]');
      if (!campo) return;
      const fila = campo.closest('[data-parametro]');
      try {
        const datos = await mandar(`/api/orquestador/parametros/${fila.dataset.parametro}`, {
          valor: campo.value,
        });
        refrescarParametro(fila, datos);
        decir('Guardado');
      } catch (err) {
        decir(err.message, true);
      }
    });

    // --- Los botones: restaurar un número, guardar o restaurar un prompt ---
    ajustes.addEventListener('click', async (ev) => {
      const restaurarNumero = ev.target.closest('[data-restaurar]');
      const guardarPrompt = ev.target.closest('[data-guardar]');
      const restaurarPrompt = ev.target.closest('[data-restaurar-prompt]');
      if (!restaurarNumero && !guardarPrompt && !restaurarPrompt) return;

      const boton = restaurarNumero ?? guardarPrompt ?? restaurarPrompt;
      boton.disabled = true;

      try {
        if (restaurarNumero) {
          const fila = boton.closest('[data-parametro]');
          const datos = await mandar(
            `/api/orquestador/parametros/${fila.dataset.parametro}/restaurar`
          );
          refrescarParametro(fila, datos);
          decir('Restaurado');
        } else {
          const caja = boton.closest('[data-prompt]');
          const fase = caja.dataset.prompt;
          const datos = guardarPrompt
            ? await mandar(`/api/orquestador/prompts/${fase}`, {
                texto: caja.querySelector('[data-texto]').value,
              })
            : await mandar(`/api/orquestador/prompts/${fase}/restaurar`);
          refrescarPrompt(caja, datos);
          decir(guardarPrompt ? 'Guardado' : 'Restaurado');
        }
      } catch (err) {
        decir(err.message, true);
      } finally {
        boton.disabled = false;
      }
    });
  }
})();
