/**
 * public/js/registro-traducido.js
 * -----------------------------------------------------------------------------
 * LA SEGUNDA LECTURA DE LA HISTORIA.
 *
 * La primera es narrativa: se entra y se lee de arriba abajo. La segunda es de
 * búsqueda, meses después, cuando uno vuelve a por un dato concreto — «¿por qué
 * no entró Wieliczka?»— y no quiere releer el viaje entero. Para eso están los
 * chips y el buscador, y para eso es todo este fichero.
 *
 * EL FILTRADO ES DE CSS, NO DE DOM. Se pone y se quita `hidden` sobre líneas que
 * ya están pintadas: nada se destruye ni se vuelve a crear, así que un
 * desplegable abierto sigue abierto al limpiar el filtro y el navegador no
 * pierde la posición del scroll. Reconstruir la lista en cada tecla sería más
 * código y peor.
 */
(() => {
  // ===========================================================================
  // GENERAR LA VISTA
  // ---------------------------------------------------------------------------
  // Dos botones distintos con el mismo trabajo: el de «este viaje no tiene
  // historia» y el de «la historia se quedó vieja, rehazla».
  // ===========================================================================
  for (const boton of document.querySelectorAll('#rt-generar')) {
    boton.addEventListener('click', async () => {
      const viaje = boton.dataset.viaje;
      const original = boton.innerHTML;
      boton.disabled = true;
      boton.textContent = 'Contándolo…';

      try {
        const r = await fetch(`/viajes/${viaje}/orquestador/vista`, { method: 'POST' });
        const datos = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(datos.error || 'no salió');
        location.reload();
      } catch (err) {
        boton.disabled = false;
        boton.innerHTML = original;
        // Se dice lo que pasó en vez de dejar el botón mudo: esto cuesta una
        // llamada de IA y puede fallar por la clave, por la red o por el modelo.
        alert(`No pude contar la historia: ${err.message}\n\nEl log en crudo sigue entero.`);
      }
    });
  }

  // ===========================================================================
  // CHIPS Y BUSCADOR
  // ===========================================================================
  const lineas = [...document.querySelectorAll('.rt-linea')];
  if (!lineas.length) return;

  const chips = [...document.querySelectorAll('.rt-chip')];
  const buscador = document.getElementById('rt-buscar');
  const sinNada = document.getElementById('rt-sinresultados');

  /** Los estados encendidos. Vacío significa TODOS, no ninguno. */
  const encendidos = new Set();
  let texto = '';

  function filtrar() {
    let vistas = 0;

    for (const l of lineas) {
      const porEstado = !encendidos.size || encendidos.has(l.dataset.estado);
      const porTexto = !texto || (l.dataset.texto ?? '').includes(texto);
      const entra = porEstado && porTexto;
      l.hidden = !entra;
      if (entra) vistas += 1;
    }

    // UN BLOQUE SIN NINGUNA LÍNEA SE ESCONDE ENTERO. Si no, al filtrar por
    // «descartado» quedaban cuatro títulos de ciudad seguidos y vacíos, que se
    // lee como que esas ciudades no tienen descartes en vez de como que no hay
    // nada que enseñar ahí.
    for (const bloque of document.querySelectorAll('.rt-bloque')) {
      const suyas = bloque.querySelectorAll('.rt-linea');
      if (!suyas.length) continue;
      bloque.hidden = ![...suyas].some((l) => !l.hidden);
    }

    if (sinNada) sinNada.hidden = vistas > 0;
  }

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const e = chip.dataset.estado;
      if (encendidos.has(e)) encendidos.delete(e);
      else encendidos.add(e);
      chip.classList.toggle('on', encendidos.has(e));
      chip.setAttribute('aria-pressed', String(encendidos.has(e)));
      filtrar();
    });
  }

  if (buscador) {
    buscador.addEventListener('input', () => {
      texto = buscador.value.trim().toLowerCase();
      filtrar();

      // BUSCAR ABRE EL PORQUÉ. Quien escribe «Wieliczka» viene justo a por la
      // razón: hacerle dar un clic más en cada resultado sobra.
      if (texto) {
        for (const l of lineas) {
          if (!l.hidden) l.querySelector('details')?.setAttribute('open', '');
        }
      }
    });
  }
})();
