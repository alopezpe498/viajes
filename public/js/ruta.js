/**
 * public/js/ruta.js
 * -----------------------------------------------------------------------------
 * La pantalla "Mi ruta": pinta las paradas y las repinta después de cada cambio.
 *
 * TODO el cálculo lo hace el servidor. Aquí no se suman noches ni se calculan
 * fechas: se manda la operación, llega la ruta entera recalculada y se vuelve a
 * pintar. Es más tráfico que actualizar solo lo que cambió, pero cambiar una
 * noche en la primera parada mueve las fechas de todas las demás y cambia los
 * tramos de en medio; con el estado completo no hay forma de desincronizarse.
 *
 * El marcado que se genera aquí tiene que ser el mismo que pinta views/ruta.ejs
 * la primera vez. Si tocas uno, toca el otro.
 */
(() => {
  const raiz = document.querySelector('.contenido--ruta');
  const datos = document.getElementById('datos-ruta');
  if (!raiz || !datos) return;

  const viajeId = raiz.dataset.viaje;
  let ruta;
  try {
    ruta = JSON.parse(datos.textContent);
  } catch {
    console.error('[ruta] los datos de partida no se pueden leer');
    return;
  }

  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  /** "2027-04-12" -> "12 abr". Sin Date: es texto, y así no hay husos de por medio. */
  function dia(iso) {
    if (!iso) return null;
    const [, m, d] = iso.split('-').map(Number);
    return `${d} ${MESES[m - 1]}`;
  }

  const noches = (n) => `${n} ${n === 1 ? 'noche' : 'noches'}`;

  /** Las noches de UNA parada. Cero noches no es "0 noches": es una de paso. */
  const nochesDeEtapa = (n) => (n > 0 ? noches(n) : 'de paso');

  /** Escapa lo que venga de la base: los nombres los ha escrito la IA o el usuario. */
  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  }

  // ===========================================================================
  // PINTAR
  // ===========================================================================
  function pintar() {
    pintarEstado();
    pintarRuta();
    pintarPorDecidir();
  }

  /**
   * LA LÍNEA DE ESTADO: noches, barra, veredicto y fechas, en una píldora.
   *
   * Sustituye a la tarjeta del contador. Dice lo mismo en un renglón, que es lo
   * que un número al que solo se le echa un vistazo necesita.
   */
  function pintarEstado() {
    const { usadas, totales, estado, diferencia } = ruta.noches;
    const caja = document.getElementById('ruta-estado');

    if (estado === 'sin_fechas') {
      caja.innerHTML = `
        <span class="ruta-estado__noches">${usadas} ${usadas === 1 ? 'noche repartida' : 'noches repartidas'}</span>
        <span class="ruta-estado__veredicto ruta-estado__veredicto--faltan">Sin fechas</span>
        <span class="ruta-estado__fechas">
          Define las fechas para repartir noches ·
          <a href="/viajes/${viajeId}/paso/1">Configuración</a>
        </span>`;
      return;
    }

    const pct = totales > 0 ? Math.min(100, (usadas / totales) * 100) : 0;
    const veredicto =
      estado === 'exceso'
        ? { clase: 'exceso', texto: `Te pasas en ${noches(diferencia)}` }
        : estado === 'exacto'
          ? { clase: 'exacto', texto: '✓ Cuadra perfecto' }
          : { clase: 'faltan', texto: `Faltan ${noches(diferencia)}` };

    caja.innerHTML = `
      <span class="ruta-estado__noches">${usadas} de ${totales} noches</span>
      <span class="ruta-estado__barra">
        <i class="ruta-estado__lleno ${estado === 'exceso' ? 'ruta-estado__lleno--exceso' : ''}"
           style="width:${pct}%"></i>
      </span>
      <span class="ruta-estado__veredicto ruta-estado__veredicto--${veredicto.clase}">${esc(veredicto.texto)}</span>
      <span class="ruta-estado__fechas">${dia(ruta.viaje.fechaInicio)} — ${dia(ruta.viaje.fechaFin)}</span>`;
  }

  /**
   * LA LÍNEA DEL VIAJE, de casa a casa.
   *
   * El orden es el del recorrido y no el de las tablas: casa, cómo se sale,
   * parada, cómo se salta a la siguiente, parada… y al final cómo se vuelve y
   * ya estás en casa. Los vuelos y los traslados van ENTRE los nodos, sobre la
   * línea, porque es donde ocurren.
   */
  function pintarRuta() {
    const zona = document.getElementById('zona-ruta');

    if (!ruta.etapas.length) {
      zona.innerHTML =
        '<p class="ruta-vacia">Todavía no hay ninguna parada. Añade una ciudad desde ' +
        'Descubrir o desde el mapa y confírmala aquí.</p>';
      return;
    }

    const trozos = [];
    trozos.push(nodoCasa('ti-home', 'Salida desde casa'));
    trozos.push(tramo(ruta.tramos.find((t) => t.donde === 'ida')));

    ruta.etapas.forEach((e, i) => {
      trozos.push(nodoEtapa(e, i));
      const salto = ruta.tramos.find((t) => t.donde === 'salto' && t.despuesDe === e.id);
      if (salto) trozos.push(tramo(salto));
    });

    trozos.push(tramo(ruta.tramos.find((t) => t.donde === 'vuelta')));
    trozos.push(nodoCasa('ti-home', 'Vuelta a casa'));

    zona.innerHTML = trozos.filter(Boolean).join('');
    engancharArrastre();
  }

  function nodoCasa(icono, texto) {
    return `
      <div class="ruta-nodo">
        <span class="ruta-punto ruta-punto--casa" aria-hidden="true"><i class="ti ${icono}"></i></span>
        <div class="ruta-casa">${esc(texto)}</div>
      </div>`;
  }

  function tramo(t) {
    if (!t) return '';
    const clase = t.resuelto ? 'ruta-tramo--resuelto' : 'ruta-tramo--pendiente';
    const icono = t.resuelto ? 'ti-check' : 'ti-alert-triangle';
    // A qué pantalla lleva: a la de la etapa DE LA QUE SALE el tramo, que es
    // donde se resuelve. La ida no sale de ninguna, así que va a la primera.
    const donde = t.despuesDe ?? t.antesDe;
    return `
      <div class="ruta-tramo ${clase}">
        <a class="ruta-tramo__medio" href="/etapa/${donde}?p=llegar">
          <i class="ti ${icono}" aria-hidden="true"></i> ${esc(t.texto)}
        </a>
        ${t.km ? `<span class="ruta-tramo__dato">${esc(t.km)}</span>` : ''}
      </div>`;
  }

  /**
   * UNA PARADA DE LA LÍNEA.
   *
   * EL BOTÓN DE LA VUELTA, QUE ANTES SE LLAMABA «CLONAR». No duplica nada: pone
   * esa ciudad otra vez al final de la ruta como parada de PASO —cero noches—
   * porque el camino de vuelta al aeropuerto pasa por allí. «Clonar» es lo que
   * hace el código por dentro, no lo que significa para quien mira su viaje, y
   * nadie tiene por qué adivinarlo. Ahora es la flecha de volver, sin texto, y
   * lo que hace se lee al posarse encima.
   */
  function nodoEtapa(e, i) {
    const fechas = e.fechaInicio ? `${dia(e.fechaInicio)} → ${dia(e.fechaFin)}` : '— → —';
    const dePaso = e.noches <= 0;

    // El chip del hotel: el nombre se trunca con elipsis y la nota va fuera del
    // trozo que se encoge, porque es lo último que se debe perder de vista.
    const dormir = e.hotel
      ? `<span class="etapa__dormir" title="${esc(e.hotel.titulo)}">
           <i class="ti ti-bed" aria-hidden="true"></i>
           <span class="etapa__dormir-nombre">${esc(e.hotel.titulo)}</span>
           ${e.hotel.valoracion ? `<span class="etapa__dormir-nota">${esc(e.hotel.valoracion)}</span>` : ''}
         </span>`
      : `<span class="etapa__dormir etapa__dormir--sin">
           <i class="ti ti-bed-off" aria-hidden="true"></i>
           <span class="etapa__dormir-nombre">Sin alojamiento</span>
         </span>`;

    return `
      <div class="ruta-nodo">
        <span class="ruta-punto ${dePaso ? 'ruta-punto--paso' : ''}" aria-hidden="true">${i + 1}</span>
        <article class="etapa" draggable="true" data-id="${e.id}" data-indice="${i}">
          <div class="etapa__cab">
            <span class="etapa__asa" aria-hidden="true"><i class="ti ti-grip-vertical"></i></span>
            <span class="etapa__info">
              <span class="etapa__nombre">${esc(e.nombre)}</span>
              <span class="etapa__fechas">${dePaso && e.fechaInicio ? `${dia(e.fechaInicio)} · parada de salida` : fechas}</span>
            </span>
            <button class="etapa__quitar" type="button" data-accion="quitar"
                    data-id="${e.id}" data-nombre="${esc(e.nombre)}" data-confirmada="1"
                    aria-label="Quitar ${esc(e.nombre)} de la ruta" title="Quitar de la ruta">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          </div>
          <div class="etapa__fila">
            <span class="etapa__noches ${dePaso ? 'etapa__noches--paso' : ''}">
              <button type="button" data-accion="noches" data-id="${e.id}" data-delta="-1"
                      aria-label="Una noche menos" ${e.noches <= 0 ? 'disabled' : ''}>−</button>
              <span class="etapa__valor">${nochesDeEtapa(e.noches)}</span>
              <button type="button" data-accion="noches" data-id="${e.id}" data-delta="1"
                      aria-label="Una noche más">+</button>
            </span>
            ${dormir}
            <span class="etapa__acciones">
              <a class="etapa__abrir" href="/etapa/${e.id}">Abrir etapa</a>
              <button class="etapa__clonar" type="button" data-accion="clonar"
                      data-id="${e.id}" data-nombre="${esc(e.nombre)}"
                      aria-label="Volver a pasar por ${esc(e.nombre)} a la vuelta"
                      title="Añade ${esc(e.nombre)} al final de la ruta como parada de paso, solo para la vuelta">
                <i class="ti ti-arrow-back-up" aria-hidden="true"></i>
              </button>
            </span>
          </div>
        </article>
      </div>`;
  }

  /**
   * CIUDADES POR DECIDIR, fuera de la línea y solo si las hay.
   *
   * No son sitios: son ciudades que llegaron con «A mi ruta» desde Descubrir o
   * desde el mapa y esperan en `recopilando`. Ésta sigue siendo la única
   * pantalla que las enseña y la única que las puede confirmar, así que aquí se
   * quedan —pero sin ocupar sitio cuando no hay ninguna, que es lo normal.
   */
  function pintarPorDecidir() {
    const zona = document.getElementById('zona-pordecidir');
    if (!zona) return;

    if (!ruta.candidatos.length) {
      zona.innerHTML = '';
      return;
    }

    zona.innerHTML =
      '<span class="ruta-pordecidir__titulo">Por decidir</span>' +
      ruta.candidatos
        .map(
          (c) => `
        <span class="ruta-pordecidir__ciudad">
          ${esc(c.nombre)}
          <button class="btn-mini--confirmar" type="button"
                  data-accion="confirmar" data-id="${c.id}">A la ruta</button>
          <button class="btn-mini--quitar" type="button"
                  data-accion="quitar" data-id="${c.id}" data-nombre="${esc(c.nombre)}">Quitar</button>
        </span>`
        )
        .join('');
  }

  // ===========================================================================
  // ACCIONES
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-accion]');
    if (!boton) return;

    const id = Number(boton.dataset.id);
    if (boton.dataset.accion === 'confirmar') {
      llamar(`/api/etapas/${id}/confirmar`);
    } else if (boton.dataset.accion === 'noches') {
      llamar(`/api/etapas/${id}/noches`, { delta: Number(boton.dataset.delta) });
    } else if (boton.dataset.accion === 'clonar') {
      llamar(`/api/etapas/${id}/clonar`);
    } else if (boton.dataset.accion === 'quitar') {
      // Un candidato se quita sin más; una parada confirmada de la ruta pregunta
      // antes, que quitarla mueve las fechas de todo lo que venga detrás.
      if (boton.dataset.confirmada) preguntar(boton.dataset.nombre, () => llamar(`/api/etapas/${id}/quitar`));
      else llamar(`/api/etapas/${id}/quitar`);
    }
  });

  /** Manda la operación y repinta con lo que devuelva el servidor. */
  async function llamar(url, cuerpo = null) {
    raiz.classList.add('contenido--esperando');
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      ruta = datos;
      pintar();
    } catch (err) {
      console.error('[ruta] no se pudo aplicar el cambio:', err);
      avisar(err.message);
    } finally {
      raiz.classList.remove('contenido--esperando');
    }
  }

  // ===========================================================================
  // ARRASTRAR PARA REORDENAR
  // ===========================================================================
  // HTML5 a pelo, sin librerías. Se suelta encima de otra parada y esa es la
  // posición nueva.
  function engancharArrastre() {
    const tarjetas = [...document.querySelectorAll('.etapa')];

    for (const tarjeta of tarjetas) {
      tarjeta.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', tarjeta.dataset.indice);
        ev.dataTransfer.effectAllowed = 'move';
        tarjeta.classList.add('etapa--arrastrando');
      });

      tarjeta.addEventListener('dragend', () => {
        tarjeta.classList.remove('etapa--arrastrando');
        for (const t of tarjetas) t.classList.remove('etapa--encima');
      });

      tarjeta.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        tarjeta.classList.add('etapa--encima');
      });

      tarjeta.addEventListener('dragleave', () => tarjeta.classList.remove('etapa--encima'));

      tarjeta.addEventListener('drop', (ev) => {
        ev.preventDefault();
        tarjeta.classList.remove('etapa--encima');

        const desde = Number(ev.dataTransfer.getData('text/plain'));
        const hasta = Number(tarjeta.dataset.indice);
        if (Number.isNaN(desde) || desde === hasta) return;

        const ids = ruta.etapas.map((e) => e.id);
        const [movida] = ids.splice(desde, 1);
        ids.splice(hasta, 0, movida);

        llamar(`/api/viajes/${viajeId}/reordenar`, { ordenIds: ids });
      });
    }
  }

  // ===========================================================================
  // MODAL Y AVISOS
  // ===========================================================================
  const modal = document.getElementById('modal');
  let alConfirmar = null;

  function preguntar(nombre, accion) {
    document.getElementById('modal-texto').textContent =
      `${nombre} saldrá de la ruta y las fechas de las paradas siguientes se moverán.`;
    alConfirmar = accion;
    modal.hidden = false;
  }

  function cerrarModal() {
    modal.hidden = true;
    alConfirmar = null;
  }

  for (const el of modal.querySelectorAll('[data-modal-cerrar]')) {
    el.addEventListener('click', cerrarModal);
  }
  document.getElementById('modal-confirmar').addEventListener('click', () => {
    const accion = alConfirmar;
    cerrarModal();
    accion?.();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal.hidden) cerrarModal();
  });

  /** Aviso corto abajo que se va solo. */
  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }

  pintar();
})();
