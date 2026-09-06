/**
 * public/js/sitio.js
 * -----------------------------------------------------------------------------
 * La ficha profunda: pestañas, "Añadir a mi ruta" y el sondeo mientras la IA
 * termina de rellenarla.
 *
 * Nada de esto necesita librerías. Las pestañas son tres botones y tres
 * secciones con `hidden`, y las mini-fichas expandibles son <details> del
 * propio HTML, que ya sabe abrirse y cerrarse solo.
 */
(() => {
  // ===========================================================================
  // PESTAÑAS
  // ===========================================================================
  const barra = document.getElementById('pestanas');
  if (barra) {
    const botones = [...barra.querySelectorAll('.pestana')];
    const paneles = botones.map((b) => document.getElementById(b.dataset.panel));

    function mostrar(indice) {
      botones.forEach((b, i) => {
        b.classList.toggle('pestana--activa', i === indice);
        b.setAttribute('aria-selected', String(i === indice));
      });
      paneles.forEach((p, i) => {
        if (p) p.hidden = i !== indice;
      });
    }

    botones.forEach((b, i) => b.addEventListener('click', () => mostrar(i)));

    // Con las flechas también, que es lo que espera quien navega con teclado.
    barra.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const actual = botones.findIndex((b) => b.classList.contains('pestana--activa'));
      const paso = ev.key === 'ArrowRight' ? 1 : -1;
      const siguiente = (actual + paso + botones.length) % botones.length;
      mostrar(siguiente);
      botones[siguiente].focus();
      ev.preventDefault();
    });
  }

  // ===========================================================================
  // AÑADIR A MI RUTA
  // ===========================================================================
  const boton = document.getElementById('boton-a-mi-ruta');
  if (boton) {
    boton.addEventListener('click', async () => {
      boton.disabled = true;
      try {
        const r = await fetch(boton.dataset.url, {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);

        boton.classList.remove('boton--primario');
        boton.classList.add('boton--hecho');
        boton.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> En tu ruta';
      } catch (err) {
        console.error('[sitio] no se pudo añadir a la ruta:', err);
        boton.disabled = false;
        avisar(err.message);
      }
    });
  }

  /** Aviso corto abajo que se va solo. Nada de alert(), que bloquea la página. */
  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }

  // ===========================================================================
  // SONDEO mientras se completa la ficha
  // ===========================================================================
  // La pantalla ya enseña lo que haya; esto solo espera a que aparezca el resto.
  const franja = document.getElementById('ficha-completando');
  if (!franja?.dataset.estadoUrl) return;

  const pista = document.getElementById('franja-pista');
  const INTERVALO = 5000;
  const arranque = Date.now();

  async function comprobar() {
    try {
      const r = await fetch(franja.dataset.estadoUrl, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      const estado = await r.json();

      if (estado.estado !== 'completando') {
        if (pista) pista.textContent = 'Listo, cargando…';
        location.reload();
        return;
      }

      const segundos = Math.round((Date.now() - arranque) / 1000);
      if (pista) pista.textContent = `Lleva ${segundos} s. Se recarga sola cuando esté.`;
    } catch (err) {
      console.error('[sitio] no se pudo consultar el estado:', err);
      if (pista) pista.textContent = 'Sin respuesta del servidor; reintentando…';
    }
    setTimeout(comprobar, INTERVALO);
  }

  setTimeout(comprobar, INTERVALO);
})();
