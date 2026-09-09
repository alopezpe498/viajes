/**
 * public/js/orquestador.js
 * -----------------------------------------------------------------------------
 * Las tres pantallas del orquestador: el progreso, los parámetros y el cerebro.
 *
 * Van juntas en un archivo porque son tres cosas pequeñas de la misma familia y
 * ninguna se usa sin las otras. Cada bloque se activa solo si encuentra lo suyo
 * en el HTML, así que cargarlo en las tres pantallas no cuesta nada.
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

        // El log crece línea a línea; se repinta entero porque son cuatro
        // frases y comparar cuál es nueva costaría más que rehacerlo.
        let log = li.querySelector('.orq-fase__log');
        if (f.log) {
          if (!log) {
            log = document.createElement('pre');
            log.className = 'orq-fase__log';
            li.querySelector('.orq-fase__explica').after(log);
          }
          log.textContent = f.log;
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
  // 2) LOS PARÁMETROS
  // ---------------------------------------------------------------------------
  // Se guardan al salir del campo, sin botón de guardar: son once números y una
  // barra de "guardar cambios" para cada uno sobraría.
  // ===========================================================================
  const listaParametros = document.querySelector('.orq-parametros');
  if (listaParametros) {
    const aviso = document.querySelector('[data-aviso-parametros]');
    const decir = (texto, malo = false) => {
      if (!aviso) return;
      aviso.textContent = texto ?? '';
      aviso.hidden = !texto;
      aviso.classList.toggle('orq-aviso--malo', Boolean(malo));
      if (texto && !malo) setTimeout(() => { aviso.hidden = true; }, 2000);
    };

    /** Deja la fila con la cara que le toca según sea de fábrica o no. */
    const refrescarFila = (fila, datos) => {
      fila.classList.toggle('orq-parametro--tocado', !datos.esDeFabrica);
      const boton = fila.querySelector('[data-restaurar]');
      if (boton) boton.hidden = datos.esDeFabrica;
      const campo = fila.querySelector('[data-valor]');
      if (campo) campo.value = datos.valor;
    };

    listaParametros.addEventListener('change', async (ev) => {
      const campo = ev.target.closest('[data-valor]');
      if (!campo) return;
      const fila = campo.closest('[data-parametro]');

      try {
        const r = await fetch(`/api/orquestador/parametros/${fila.dataset.parametro}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ valor: campo.value }),
        });
        const datos = await r.json();
        if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
        refrescarFila(fila, datos);
        decir('Guardado');
      } catch (err) {
        decir(err.message, true);
      }
    });

    listaParametros.addEventListener('click', async (ev) => {
      const boton = ev.target.closest('[data-restaurar]');
      if (!boton) return;
      const fila = boton.closest('[data-parametro]');

      try {
        const r = await fetch(
          `/api/orquestador/parametros/${fila.dataset.parametro}/restaurar`,
          { method: 'POST', headers: { Accept: 'application/json' } }
        );
        const datos = await r.json();
        if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
        refrescarFila(fila, datos);
        decir('Restaurado');
      } catch (err) {
        decir(err.message, true);
      }
    });
  }

  // ===========================================================================
  // 3) EL CEREBRO
  // ---------------------------------------------------------------------------
  // Aquí sí hay botón de guardar: un prompt es un texto largo y guardar al salir
  // del campo mientras alguien lo está escribiendo daría sustos.
  // ===========================================================================
  const prompts = [...document.querySelectorAll('[data-prompt]')];
  if (prompts.length) {
    const aviso = document.querySelector('[data-aviso-prompt]');
    const decir = (texto, malo = false) => {
      if (!aviso) return;
      aviso.textContent = texto ?? '';
      aviso.hidden = !texto;
      aviso.classList.toggle('orq-aviso--malo', Boolean(malo));
      if (texto && !malo) setTimeout(() => { aviso.hidden = true; }, 2000);
    };

    const refrescar = (caja, datos) => {
      caja.classList.toggle('orq-prompt--tocado', !datos.esDeFabrica);
      const boton = caja.querySelector('[data-restaurar-prompt]');
      if (boton) boton.hidden = datos.esDeFabrica;
      const cuando = caja.querySelector('.orq-prompt__cuando');
      if (cuando) cuando.textContent = datos.esDeFabrica ? 'Como vino de fábrica' : 'Editado ahora mismo';
      const texto = caja.querySelector('[data-texto]');
      if (texto) texto.value = datos.prompt_actual;
    };

    for (const caja of prompts) {
      const fase = caja.dataset.prompt;

      caja.querySelector('[data-guardar]')?.addEventListener('click', async () => {
        const texto = caja.querySelector('[data-texto]').value;
        try {
          const r = await fetch(`/api/orquestador/prompts/${fase}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ texto }),
          });
          const datos = await r.json();
          if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
          refrescar(caja, datos);
          decir('Guardado');
        } catch (err) {
          decir(err.message, true);
        }
      });

      caja.querySelector('[data-restaurar-prompt]')?.addEventListener('click', async () => {
        try {
          const r = await fetch(`/api/orquestador/prompts/${fase}/restaurar`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
          });
          const datos = await r.json();
          if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
          refrescar(caja, datos);
          decir('Restaurado');
        } catch (err) {
          decir(err.message, true);
        }
      });
    }
  }
})();
