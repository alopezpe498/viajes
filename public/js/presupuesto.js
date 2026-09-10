/**
 * public/js/presupuesto.js
 * -----------------------------------------------------------------------------
 * El único trozo vivo de la pantalla de presupuesto: la caja de lo estimado.
 *
 * Lo planificado no se toca desde aquí —son precios de las búsquedas, y se
 * cambian donde se eligió cada cosa—, así que este archivo solo hace dos cosas:
 *
 *   1. Guardar el importe diario que escribe el usuario. Al SALIR del campo, no
 *      en cada tecla: una cifra se teclea de un tirón. A partir de ese momento
 *      la estimación es suya y el botón de recalcular se apaga, porque nadie
 *      puede pisar lo que uno ha escrito a mano.
 *   2. Pedir una estimación nueva.
 *
 * En las dos, el servidor devuelve el presupuesto entero recalculado y aquí solo
 * se repintan los números. Sumar en el navegador sería tener la aritmética en
 * dos sitios, y el día que cambiara una regla, uno de los dos mentiría.
 */
(() => {
  'use strict';

  const caja = document.getElementById('pre-estimado');
  if (!caja) return;

  const viajeId = document.querySelector('[data-viaje]')?.dataset.viaje;
  const campo = document.getElementById('pre-importe');
  const boton = document.getElementById('pre-recalcular');
  const estado = caja.querySelector('[data-estado]');

  const totalEstimado = document.getElementById('pre-estimado-total');
  const totalOrientativo = document.getElementById('pre-orientativo-total');
  const porque = document.getElementById('pre-porque');

  const euros = (n) =>
    n == null
      ? '—'
      : `${n.toLocaleString('es-ES', { maximumFractionDigits: 0 })} €`;

  const decir = (texto, malo = false) => {
    if (!estado) return;
    estado.textContent = texto ?? '';
    estado.classList.toggle('pre-estimado__estado--malo', Boolean(malo));
    if (texto && !malo) setTimeout(() => { estado.textContent = ''; }, 2500);
  };

  /** Repinta lo que ha cambiado. El servidor manda; aquí no se calcula nada. */
  function pintar(presupuesto, estimacion) {
    if (presupuesto) {
      if (totalEstimado) totalEstimado.textContent = euros(presupuesto.estimado.total);
      if (totalOrientativo) totalOrientativo.textContent = euros(presupuesto.orientativo.total);
    }
    if (!estimacion || !porque) return;

    caja.dataset.tocado = estimacion.tocadoAMano ? '1' : '';
    if (boton) boton.disabled = Boolean(estimacion.tocadoAMano);

    const icono = estimacion.tocadoAMano
      ? 'ti-pencil'
      : estimacion.porque
        ? 'ti-sparkles'
        : 'ti-help-circle';
    const texto = estimacion.tocadoAMano
      ? 'Lo has puesto tú: no se recalcula solo.'
      : estimacion.porque || 'Todavía sin estimar.';

    porque.innerHTML = `<i class="ti ${icono}" aria-hidden="true"></i> `;
    porque.append(texto);
  }

  // ===========================================================================
  // 1) EL IMPORTE QUE ESCRIBE EL USUARIO
  // ===========================================================================
  campo?.addEventListener('change', async () => {
    const valor = campo.value.trim();
    if (valor === '') return; // borrarlo no es una decisión: no se guarda nada

    decir('Guardando…');
    try {
      const r = await fetch(`/api/viaje/${viajeId}/presupuesto/importe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importe: Number(valor) }),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error ?? `El servidor respondió ${r.status}`);

      pintar(datos.presupuesto, datos.estimacion);
      decir('Guardado');
    } catch (err) {
      decir(`No se ha podido guardar: ${err.message}`, true);
    }
  });

  // ===========================================================================
  // 2) VOLVER A ESTIMAR
  // ===========================================================================
  boton?.addEventListener('click', async () => {
    boton.disabled = true;
    decir('Estimando…');
    try {
      const r = await fetch(`/api/viaje/${viajeId}/presupuesto/recalcular`, { method: 'POST' });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error ?? `El servidor respondió ${r.status}`);

      if (campo && datos.estimacion?.importe != null) campo.value = datos.estimacion.importe;
      pintar(datos.presupuesto, datos.estimacion);
      boton.innerHTML = '<i class="ti ti-refresh" aria-hidden="true"></i> Recalcular';
      decir('Listo');
    } catch (err) {
      decir(`No se ha podido estimar: ${err.message}`, true);
    } finally {
      // Si la estimación pasó a ser del usuario, `pintar` ya lo ha dejado
      // apagado; si no, vuelve a estar disponible.
      boton.disabled = Boolean(caja.dataset.tocado);
    }
  });
})();
