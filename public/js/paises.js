/**
 * public/js/paises.js
 * -----------------------------------------------------------------------------
 * El diálogo de países: marcar, volver a preguntar, y confirmar.
 *
 * TRES COMPORTAMIENTOS Y NINGUNO MÁS:
 *
 *   1. Al abrir, si no hay opinión guardada se pide una. Si la hay, se pinta:
 *      recargar la pantalla no puede costar otra llamada.
 *   2. Al marcar o desmarcar, se vuelve a preguntar SOBRE LA SELECCIÓN NUEVA.
 *      Con un respiro de por medio: marcar tres países seguidos son tres clics
 *      y una sola pregunta, no tres.
 *   3. Al confirmar, se cierra la lista y el viaje arranca.
 *
 * EL VETO NO VIVE AQUÍ. Cuando la IA dice que no cabe, esta pantalla esconde el
 * botón; pero quien lo impide de verdad es el servidor, que vuelve a mirar la
 * última opinión antes de dejar pasar nada. Un botón escondido con CSS no es
 * una regla.
 */
(() => {
  'use strict';

  const raiz = document.querySelector('[data-viaje]');
  if (!raiz) return;

  const viajeId = raiz.dataset.viaje;
  const datos = JSON.parse(document.getElementById('datos-paises').textContent);

  const zonaOpinion = document.getElementById('paises-opinion');
  const lista = document.getElementById('paises-lista');
  const boton = document.getElementById('paises-confirmar');
  const botonTexto = document.getElementById('paises-confirmar-texto');
  const estado = document.getElementById('paises-estado');

  let dialogo = datos.dialogo ?? null;
  let pidiendo = false;
  let reloj = null;

  const esc = (t) => {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  };

  /** Los países marcados ahora mismo, en el orden de la lista. */
  const seleccion = () =>
    [...lista.querySelectorAll('[data-marca]')].filter((c) => c.checked).map((c) => c.value);

  // ===========================================================================
  // PINTAR
  // ===========================================================================
  function pintar() {
    if (!dialogo) return;

    const noCabe = dialogo.veredicto === 'no_cabe';

    zonaOpinion.className = `paises-opinion ${noCabe ? 'paises-opinion--no-cabe' : ''}`;
    zonaOpinion.innerHTML =
      (noCabe
        ? '<p class="paises-veredicto"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ' +
          'Esto no cabe en los días que hay</p>' +
          (dialogo.porQueNoCabe ? `<p class="paises-numeros">${esc(dialogo.porQueNoCabe)}</p>` : '')
        : '') +
      (dialogo.opinion ? `<p class="paises-texto">${esc(dialogo.opinion)}</p>` : '');

    // La frase de cada país, y si la IA lo dejaría dentro.
    for (const d of dialogo.paises ?? []) {
      const fila = lista.querySelector(`[data-pais="${CSS.escape(d.nombre)}"]`);
      if (!fila) continue;
      fila.classList.toggle('pais-fila--no-recomendado', d.recomendado === false);
      const porque = fila.querySelector('[data-porque]');
      if (porque) {
        porque.innerHTML =
          (d.recomendado === false
            ? '<span class="pais-fila__sello">lo quitaría</span> '
            : '') + esc(d.porQue ?? '');
      }
    }

    // INSISTIR SE PUEDE; MONTAR UN IMPOSIBLE, NO.
    boton.hidden = noCabe;
    if (botonTexto) {
      const hayDesacuerdo = (dialogo.paises ?? []).some(
        (d) => d.marcado && d.recomendado === false
      );
      botonTexto.textContent = hayDesacuerdo ? 'Así lo quiero igualmente' : 'Así lo quiero';
    }
  }

  const decir = (t, malo = false) => {
    estado.textContent = t ?? '';
    estado.classList.toggle('paises-estado--malo', Boolean(malo));
  };

  // ===========================================================================
  // PREGUNTAR
  // ===========================================================================
  async function opinar() {
    if (pidiendo) return;
    pidiendo = true;
    decir('Pensando…');
    zonaOpinion.classList.add('paises-opinion--pensando');

    try {
      const r = await fetch(`/api/viajes/${viajeId}/paises/opinar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seleccion: seleccion() }),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cuerpo.error || `El servidor respondió ${r.status}`);

      dialogo = cuerpo.dialogo;
      pintar();
      decir('');
    } catch (err) {
      console.error('[paises] no se pudo consultar el criterio:', err);
      zonaOpinion.innerHTML =
        `<p class="paises-texto">No he podido pedir el criterio: ${esc(err.message)}. ` +
        'Puedes confirmar igualmente.</p>';
      decir('');
    } finally {
      pidiendo = false;
      zonaOpinion.classList.remove('paises-opinion--pensando');
    }
  }

  // Marcar tres países seguidos son tres clics y UNA pregunta.
  lista.addEventListener('change', (ev) => {
    if (!ev.target.matches('[data-marca]')) return;

    if (!seleccion().length) {
      decir('Deja al menos un país.', true);
      ev.target.checked = true;
      return;
    }

    decir('');
    clearTimeout(reloj);
    reloj = setTimeout(opinar, 700);
  });

  // ===========================================================================
  // CONFIRMAR
  // ===========================================================================
  boton.addEventListener('click', async () => {
    boton.disabled = true;
    decir('Cerrando la lista…');
    try {
      const r = await fetch(`/api/viajes/${viajeId}/paises/confirmar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seleccion: seleccion() }),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cuerpo.porQueNoCabe || cuerpo.error || `Error ${r.status}`);
      window.location.href = cuerpo.url;
    } catch (err) {
      decir(err.message, true);
      boton.disabled = false;
    }
  });

  // ===========================================================================
  // AL ABRIR
  // ===========================================================================
  if (dialogo) {
    // Se repone la selección que se estaba mirando, no la de fábrica.
    for (const c of lista.querySelectorAll('[data-marca]')) {
      c.checked = (dialogo.seleccion ?? []).includes(c.value);
    }
    pintar();
  } else {
    opinar();
  }
})();
