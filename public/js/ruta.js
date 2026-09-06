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
    pintarContador();
    pintarCandidatos();
    pintarRuta();
  }

  function pintarContador() {
    const { usadas, totales, estado, diferencia } = ruta.noches;
    const caja = document.getElementById('ruta-contador');

    if (estado === 'sin_fechas') {
      caja.innerHTML = `
        <div class="ruta-contador__fila">
          <span class="ruta-contador__texto">${usadas} ${usadas === 1 ? 'noche repartida' : 'noches repartidas'}</span>
        </div>
        <p class="ruta-contador__aviso">
          Define las fechas del viaje para repartir noches.
          <a href="/viajes/${viajeId}/paso/1">Ir a la configuración</a>
        </p>`;
      return;
    }

    const pct = totales > 0 ? Math.min(100, (usadas / totales) * 100) : 0;
    const aviso =
      estado === 'exceso'
        ? { clase: 'ruta-contador__aviso ruta-contador__aviso--exceso',
            texto: `Te pasas en ${noches(diferencia)}: quita noches o alarga el viaje` }
        : estado === 'exacto'
          ? { clase: 'ruta-contador__aviso ruta-contador__aviso--exacto', texto: 'Cuadra perfecto' }
          : { clase: 'ruta-contador__aviso', texto: `Te quedan ${noches(diferencia)} por colocar` };

    caja.innerHTML = `
      <div class="ruta-contador__fila">
        <span class="ruta-contador__texto">${usadas} de ${totales} noches repartidas</span>
        <span class="ruta-contador__fechas">
          ${dia(ruta.viaje.fechaInicio)} — ${dia(ruta.viaje.fechaFin)} · ${noches(totales)}
        </span>
      </div>
      <div class="ruta-barra">
        <div class="ruta-barra__lleno ${estado === 'exceso' ? 'ruta-barra__lleno--exceso' : ''}" style="width:${pct}%"></div>
      </div>
      <p class="${aviso.clase}">
        ${estado === 'exacto' ? '<i class="ti ti-check" aria-hidden="true"></i> ' : ''}${esc(aviso.texto)}
      </p>`;
  }

  function pintarCandidatos() {
    document.getElementById('num-candidatos').textContent = ruta.candidatos.length;
    const zona = document.getElementById('zona-candidatos');

    if (!ruta.candidatos.length) {
      zona.innerHTML =
        '<p class="candidatos__vacio">Nada pendiente — marca sitios desde la pantalla ' +
        'Descubrir y aparecerán aquí.</p>';
      return;
    }

    zona.innerHTML = ruta.candidatos
      .map(
        (c) => `
        <div class="candidato">
          <span class="candidato__nombre">${esc(c.nombre)}</span>
          <span class="candidato__botones">
            <button class="btn-mini btn-mini--confirmar" type="button"
                    data-accion="confirmar" data-id="${c.id}">A la ruta</button>
            <button class="btn-mini btn-mini--quitar" type="button"
                    data-accion="quitar" data-id="${c.id}" data-nombre="${esc(c.nombre)}">Quitar</button>
          </span>
        </div>`
      )
      .join('');
  }

  function pintarRuta() {
    document.getElementById('num-etapas').textContent = ruta.etapas.length;
    const zona = document.getElementById('zona-ruta');

    if (!ruta.etapas.length) {
      zona.innerHTML =
        '<p class="candidatos__vacio">Todavía no hay ninguna parada. Pasa un candidato ' +
        '"a la ruta" para empezar.</p>';
      return;
    }

    const trozos = [];

    // El extremo de salida, y justo después su chip de transporte.
    trozos.push(extremo('ti-home', 'Salida desde casa'));
    trozos.push(chipDe(ruta.tramos.find((t) => t.donde === 'ida')));

    ruta.etapas.forEach((e, i) => {
      trozos.push(tarjetaEtapa(e, i));
      // El salto hacia la siguiente parada, si la hay.
      const salto = ruta.tramos.find((t) => t.donde === 'salto' && t.despuesDe === e.id);
      if (salto) trozos.push(chipDe(salto));
    });

    // El chip de la vuelta va ANTES del extremo, como en la maqueta: primero
    // cómo vuelves, y luego que ya estás en casa.
    trozos.push(chipDe(ruta.tramos.find((t) => t.donde === 'vuelta')));
    trozos.push(extremo('ti-home', 'Vuelta a casa'));

    zona.innerHTML = trozos.filter(Boolean).join('');
    engancharArrastre();
  }

  function extremo(icono, texto) {
    return `
      <div class="extremo">
        <span class="extremo__icono"><i class="ti ${icono}" aria-hidden="true"></i></span>
        ${esc(texto)}
      </div>`;
  }

  function chipDe(tramo) {
    if (!tramo) return '';
    const clase = tramo.resuelto ? 'chip-transporte--resuelto' : 'chip-transporte--pendiente';
    const icono = tramo.resuelto ? 'ti-check' : 'ti-alert-triangle';
    // A qué pantalla lleva el chip: a la de la etapa DE LA QUE SALE el tramo,
    // que es donde se resuelve. La ida no sale de ninguna (viene de casa), así
    // que esa se ve en la pantalla de la primera parada.
    const donde = tramo.despuesDe ?? tramo.antesDe;
    return `
      <div class="ruta-tramo">
        <a class="chip-transporte ${clase}" href="/etapa/${donde}#llegar">
          <i class="ti ${icono}" aria-hidden="true"></i> ${esc(tramo.texto)}
        </a>
      </div>`;
  }

  function tarjetaEtapa(e, i) {
    const fechas = e.fechaInicio ? `${dia(e.fechaInicio)} → ${dia(e.fechaFin)}` : '— → —';
    return `
      <article class="etapa" draggable="true" data-id="${e.id}" data-indice="${i}">
        <span class="etapa__asa" aria-hidden="true"><i class="ti ti-grip-vertical"></i></span>
        <span class="etapa__orden">${i + 1}</span>
        <span class="etapa__info">
          <span class="etapa__nombre">${esc(e.nombre)}</span>
          <span class="etapa__fechas">${fechas}</span>
        </span>
        <span class="etapa__noches">
          <button type="button" data-accion="noches" data-id="${e.id}" data-delta="-1"
                  aria-label="Una noche menos" ${e.noches <= 1 ? 'disabled' : ''}>−</button>
          <span class="etapa__valor">${noches(e.noches)}</span>
          <button type="button" data-accion="noches" data-id="${e.id}" data-delta="1"
                  aria-label="Una noche más">+</button>
        </span>
        <a class="etapa__abrir" href="/etapa/${e.id}">Abrir etapa</a>
        <button class="etapa__quitar" type="button" data-accion="quitar"
                data-id="${e.id}" data-nombre="${esc(e.nombre)}" data-confirmada="1"
                aria-label="Quitar ${esc(e.nombre)} de la ruta" title="Quitar de la ruta">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </article>`;
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
