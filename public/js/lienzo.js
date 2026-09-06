/**
 * public/js/lienzo.js
 * -----------------------------------------------------------------------------
 * El lienzo: la mochila, los días y el arrastre entre los dos.
 *
 * El servidor calcula TODO —qué día es de qué ciudad, los bloques fijos de
 * transporte, los avisos de incoherencia— y aquí solo se pinta. Cada cambio
 * manda la operación y recibe el lienzo entero recalculado: mover una tarjeta
 * puede encender un aviso en otro día, así que remendar el DOM a mano sería
 * quedarse corto.
 *
 * Arrastre con HTML5 a pelo, sin librerías.
 */
(() => {
  const pantalla = document.querySelector('.lienzo-pantalla');
  const datos = document.getElementById('datos-lienzo');
  if (!pantalla || !datos) return;

  const viajeId = pantalla.dataset.viaje;

  let lienzo;
  try {
    lienzo = JSON.parse(datos.textContent);
  } catch {
    console.error('[lienzo] los datos de partida no se pueden leer');
    return;
  }

  /** Filtro de tipo de la mochila. El de ciudad va en la URL. */
  let filtroTipo = 'todo';

  const ICONO_TIPO = {
    sitio: 'ti-map-pin',
    actividad: 'ti-ticket',
    comer: 'ti-tools-kitchen-2',
    manual: 'ti-pencil',
  };

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  }

  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }

  // ===========================================================================
  // PINTAR
  // ===========================================================================
  function pintar() {
    pintarFiltrosCiudad();
    pintarFiltrosTipo();
    pintarMochila();
    pintarDias();
  }

  function pintarFiltrosCiudad() {
    const zona = document.getElementById('filtros-ciudad');
    const base = `/viaje/${viajeId}/lienzo`;

    zona.innerHTML =
      `<a class="lienzo-filtro ${!lienzo.etapaId ? 'lienzo-filtro--activo' : ''}" href="${base}">Todo el viaje</a>` +
      lienzo.etapas
        .map(
          (e) => `<a class="lienzo-filtro ${lienzo.etapaId === e.id ? 'lienzo-filtro--activo' : ''}"
                     href="${base}?etapa=${e.id}">${esc(e.nombre)}</a>`
        )
        .join('');
  }

  function pintarFiltrosTipo() {
    const zona = document.getElementById('filtros-tipo');
    // Solo los chips de tipos que de verdad hay algo: un filtro que no filtra
    // nada solo ocupa sitio.
    if (!lienzo.tiposPresentes.length) {
      zona.innerHTML = '';
      return;
    }

    zona.innerHTML =
      `<button class="tipo-chip ${filtroTipo === 'todo' ? 'tipo-chip--activo' : ''}"
               type="button" data-tipo="todo">Todo</button>` +
      lienzo.tiposPresentes
        .map(
          (t) => `<button class="tipo-chip ${filtroTipo === t.clave ? 'tipo-chip--activo' : ''}"
                          type="button" data-tipo="${t.clave}">
                    <i class="ti ${t.icono}" aria-hidden="true"></i> ${esc(t.etiqueta)}
                  </button>`
        )
        .join('');
  }

  function pintarMochila() {
    const zona = document.getElementById('mochila-contenido');
    const dentro = lienzo.mochila.filter((m) => filtroTipo === 'todo' || m.tipo === filtroTipo);

    const porRecolocar = lienzo.porRecolocar
      ? `<p class="mochila__aviso">
           <i class="ti ti-calendar-event" aria-hidden="true"></i>
           Se movieron tus fechas: ${lienzo.porRecolocar}
           ${lienzo.porRecolocar === 1 ? 'cosa' : 'cosas'} por recolocar.
         </p>`
      : '';

    if (!dentro.length) {
      zona.innerHTML = porRecolocar + '<p class="mochila__vacia"><i class="ti ti-check" aria-hidden="true"></i> Nada aquí: todo repartido</p>';
      return;
    }

    // Agrupadas por ciudad, en el orden de la ruta.
    const porCiudad = new Map();
    for (const m of dentro) {
      if (!porCiudad.has(m.ciudad)) porCiudad.set(m.ciudad, []);
      porCiudad.get(m.ciudad).push(m);
    }

    zona.innerHTML =
      porRecolocar +
      [...porCiudad.entries()]
        .map(
          ([ciudad, lista]) => `
        <div class="grupo">
          <div class="grupo__titulo">${esc(ciudad)}</div>
          ${lista.map((m) => tarjetaMochila(m)).join('')}
        </div>`
        )
        .join('');
  }

  function tarjetaMochila(m) {
    return `
      <article class="item item--${m.tipo} ${m.recolocar ? 'item--recolocar' : ''}"
               draggable="true" data-candidato="${m.id}">
        <div class="item__fila">
          <i class="ti ${ICONO_TIPO[m.tipo] || 'ti-point'}" aria-hidden="true"></i>
          <span class="item__nombre">${esc(m.nombre)}</span>
        </div>
        ${meta(m)}
      </article>`;
  }

  /** La línea de debajo: hora en negrita, duración y precio, lo que haya. */
  function meta(x) {
    const trozos = [];
    if (x.hora) trozos.push(`<span class="item__hora">${esc(x.hora)}</span>`);
    if (x.duracion) trozos.push(esc(x.duracion));
    if (x.precio != null) trozos.push(`${x.precio} ${esc(x.moneda || 'EUR')}`);
    return trozos.length ? `<div class="item__meta">${trozos.join(' · ')}</div>` : '';
  }

  function pintarDias() {
    const zona = document.getElementById('lienzo-dias');

    if (!lienzo.dias.length) {
      zona.innerHTML = `
        <div class="lienzo-vacio">
          <i class="ti ti-calendar-off" aria-hidden="true"></i>
          <p><strong>Todavía no hay días que repartir</strong></p>
          <p class="secundario">Confirma etapas y reparte noches para tener días aquí.</p>
          <a class="boton boton--primario" href="/viaje/${viajeId}/ruta">
            <i class="ti ti-route" aria-hidden="true"></i> Ir a la ruta
          </a>
        </div>`;
      return;
    }

    // Los avisos marcan tarjetas concretas: se prepara el conjunto una vez, y
    // no se busca dentro del bucle por cada tarjeta.
    const enConflicto = new Set(lienzo.avisos.flatMap((a) => a.idsAfectados));

    zona.innerHTML = lienzo.dias.map((d) => columnaDia(d, enConflicto)).join('');
  }

  function columnaDia(d, enConflicto) {
    const avisos = lienzo.avisos.filter((a) => a.dia === d.n);

    return `
      <section class="dia" data-dia="${d.n}">
        <header class="dia__cabecera">
          <span class="dia__num">Día ${d.n}</span>
          <span class="dia__fecha">· ${esc(d.fechaCorta)}</span>
          <span class="chip-ciudad" style="background:${d.color.fondo};color:${d.color.texto}">
            ${esc(d.ciudad)}
          </span>
        </header>

        ${avisos
          .map(
            (a) => `<p class="aviso-dia"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${esc(a.texto)}</p>`
          )
          .join('')}

        ${lienzo.franjas.map((f) => bloqueFranja(d, f, enConflicto)).join('')}
      </section>`;
  }

  function bloqueFranja(d, f, enConflicto) {
    const fijos = lienzo.fijos.filter((x) => x.dia === d.n && x.franja === f.clave);
    const cosas = lienzo.colocados.filter((c) => c.dia === d.n && c.franja === f.clave);

    return `
      <div class="lienzo-franja" data-dia="${d.n}" data-franja="${f.clave}">
        <div class="lienzo-franja__cabecera">
          <span class="lienzo-franja__titulo">${esc(f.etiqueta)}
            <span class="lienzo-franja__horas">· ${esc(f.horas)}</span>
          </span>
          <button class="btn-mano" type="button" title="Añadir algo a mano"
                  data-mano="${d.n}" data-franja="${f.clave}">
            <i class="ti ti-plus" aria-hidden="true"></i>
          </button>
        </div>

        ${fijos
          .map(
            (x) => `<div class="fijo"><i class="ti ${x.icono}" aria-hidden="true"></i> ${esc(x.texto)}</div>`
          )
          .join('')}

        ${cosas.map((c) => tarjetaColocada(c, enConflicto.has(c.id))).join('')}
      </div>`;
  }

  function tarjetaColocada(c, conflicto) {
    return `
      <article class="item item--${c.tipo} ${conflicto ? 'item--conflicto' : ''}"
               draggable="true" data-fila="${c.id}">
        <div class="item__fila">
          <i class="ti ${ICONO_TIPO[c.tipo] || 'ti-point'}" aria-hidden="true"></i>
          <span class="item__nombre">${esc(c.nombre)}</span>
          <button class="item__quitar" type="button" data-quitar="${c.id}"
                  title="${c.manual ? 'Borrar' : 'Devolver a la mochila'}"
                  aria-label="${c.manual ? 'Borrar' : 'Devolver a la mochila'}">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>
        ${meta(c)}
      </article>`;
  }

  // ===========================================================================
  // HABLAR CON EL SERVIDOR
  // ===========================================================================
  /** Manda la operación y repinta con el lienzo que devuelva. */
  async function llamar(url, opciones = {}) {
    pantalla.classList.add('lienzo-pantalla--esperando');
    try {
      const r = await fetch(url, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        ...opciones,
      });
      const respuesta = await r.json();
      if (!r.ok) throw new Error(respuesta.error || `Error ${r.status}`);

      lienzo = respuesta;
      pintar();
    } catch (err) {
      console.error('[lienzo] no se pudo aplicar el cambio:', err);
      avisar(err.message);
    } finally {
      pantalla.classList.remove('lienzo-pantalla--esperando');
    }
  }

  /** El filtro de etapa viaja en cada llamada, o el repintado lo perdería. */
  const conEtapa = (extra = {}) => ({ ...extra, etapa: lienzo.etapaId ?? '' });

  function colocar(candidatoId, dia, franja) {
    return llamar('/api/itinerario', {
      method: 'POST',
      body: JSON.stringify(conEtapa({ viajeId: Number(viajeId), candidatoId, dia, franja })),
    });
  }

  function moverFila(id, dia, franja) {
    return llamar(`/api/itinerario/${id}/mover`, {
      method: 'POST',
      body: JSON.stringify(conEtapa({ dia, franja })),
    });
  }

  function quitarFila(id) {
    const sufijo = lienzo.etapaId ? `?etapa=${lienzo.etapaId}` : '';
    return llamar(`/api/itinerario/${id}${sufijo}`, { method: 'DELETE' });
  }

  // ===========================================================================
  // CLICS
  // ===========================================================================
  pantalla.addEventListener('click', (ev) => {
    const tipo = ev.target.closest('[data-tipo]');
    if (tipo) {
      filtroTipo = tipo.dataset.tipo;
      pintarFiltrosTipo();
      pintarMochila();
      return;
    }

    const quitar = ev.target.closest('[data-quitar]');
    if (quitar) {
      quitarFila(Number(quitar.dataset.quitar));
      return;
    }

    const mano = ev.target.closest('[data-mano]');
    if (mano) abrirFormularioManual(mano);
  });

  /**
   * El formulario de añadir a mano. Inline y con el estilo de la casa: un
   * prompt() del navegador aquí sería un bofetón en medio de una pantalla que
   * va de arrastrar cosas con el ratón.
   */
  function abrirFormularioManual(boton) {
    const franja = boton.closest('.lienzo-franja');
    if (franja.querySelector('.manual-rapido')) return;   // ya está abierto

    const form = document.createElement('form');
    form.className = 'manual-rapido';
    form.innerHTML = `
      <input class="manual-rapido__texto" name="texto" type="text" maxlength="120"
             placeholder="Qué hay que hacer" autocomplete="off">
      <div class="manual-rapido__fila">
        <input class="manual-rapido__hora" name="hora" type="time" aria-label="Hora (opcional)">
        <button class="manual-rapido__ok" type="submit">Añadir</button>
        <button class="manual-rapido__no" type="button" data-cerrar-manual>Cancelar</button>
      </div>`;

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const texto = form.texto.value.trim();
      if (!texto) return;
      llamar('/api/itinerario', {
        method: 'POST',
        body: JSON.stringify(
          conEtapa({
            viajeId: Number(viajeId),
            textoManual: texto,
            dia: Number(boton.dataset.mano),
            franja: boton.dataset.franja,
            hora: form.hora.value || null,
          })
        ),
      });
    });

    form.querySelector('[data-cerrar-manual]').addEventListener('click', () => form.remove());

    franja.appendChild(form);
    form.texto.focus();
  }

  // ===========================================================================
  // ARRASTRAR
  // ===========================================================================
  // Se engancha por delegación en el contenedor: las tarjetas se rehacen en
  // cada repintado, así que poner escuchas una por una sería volver a ponerlas
  // después de cada cambio.
  pantalla.addEventListener('dragstart', (ev) => {
    const item = ev.target.closest('.item');
    if (!item) return;

    // Lo que viaja: de dónde sale la tarjeta y qué es.
    const carga = item.dataset.fila
      ? { fila: Number(item.dataset.fila) }
      : { candidato: Number(item.dataset.candidato) };

    ev.dataTransfer.setData('text/plain', JSON.stringify(carga));
    ev.dataTransfer.effectAllowed = 'move';
    item.classList.add('item--arrastrando');
  });

  pantalla.addEventListener('dragend', (ev) => {
    ev.target.closest('.item')?.classList.remove('item--arrastrando');
    for (const z of document.querySelectorAll('.lienzo-franja--sobre, .mochila--sobre')) {
      z.classList.remove('lienzo-franja--sobre', 'mochila--sobre');
    }
  });

  pantalla.addEventListener('dragover', (ev) => {
    const franja = ev.target.closest('.lienzo-franja');
    const mochila = ev.target.closest('.mochila');
    if (!franja && !mochila) return;

    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    if (franja) franja.classList.add('lienzo-franja--sobre');
    if (mochila) mochila.classList.add('mochila--sobre');
  });

  pantalla.addEventListener('dragleave', (ev) => {
    ev.target.closest('.lienzo-franja')?.classList.remove('lienzo-franja--sobre');
    ev.target.closest('.mochila')?.classList.remove('mochila--sobre');
  });

  pantalla.addEventListener('drop', (ev) => {
    const franja = ev.target.closest('.lienzo-franja');
    const mochila = ev.target.closest('.mochila');
    if (!franja && !mochila) return;

    ev.preventDefault();
    franja?.classList.remove('lienzo-franja--sobre');
    mochila?.classList.remove('mochila--sobre');

    let carga;
    try {
      carga = JSON.parse(ev.dataTransfer.getData('text/plain'));
    } catch {
      return;
    }

    if (mochila) {
      // Soltar en la mochila es sacarlo del lienzo. Lo que venía de la propia
      // mochila no se mueve a ningún sitio.
      if (carga.fila) quitarFila(carga.fila);
      return;
    }

    const dia = Number(franja.dataset.dia);
    const clave = franja.dataset.franja;
    if (carga.fila) moverFila(carga.fila, dia, clave);
    else if (carga.candidato) colocar(carga.candidato, dia, clave);
  });

  // ===========================================================================
  // LA OPINIÓN DE LA IA
  // ===========================================================================
  const cajaOpinion = document.getElementById('opinion');
  let opinionInicial = { opinion: null, pensando: false };
  try {
    opinionInicial = JSON.parse(document.getElementById('datos-opinion').textContent);
  } catch { /* sin opinión */ }

  function pintarOpinion({ opinion, pensando, error }) {
    if (pensando) {
      cajaOpinion.hidden = false;
      cajaOpinion.className = 'opinion opinion--pensando';
      cajaOpinion.innerHTML =
        '<span class="rueda" aria-hidden="true"></span> <span>Pensando…</span>';
      return;
    }
    if (error) {
      cajaOpinion.hidden = false;
      cajaOpinion.className = 'opinion opinion--mala';
      cajaOpinion.innerHTML = `<i class="ti ti-alert-triangle" aria-hidden="true"></i> <span>${esc(error)}</span>`;
      return;
    }
    if (opinion) {
      cajaOpinion.hidden = false;
      cajaOpinion.className = 'opinion';
      cajaOpinion.innerHTML = `
        <i class="ti ti-sparkles opinion__icono" aria-hidden="true"></i>
        <div class="opinion__texto">${esc(opinion)}</div>
        <button class="opinion__cerrar" type="button" aria-label="Cerrar">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>`;
      cajaOpinion.querySelector('.opinion__cerrar').addEventListener('click', () => {
        cajaOpinion.hidden = true;
      });
      return;
    }
    cajaOpinion.hidden = true;
  }

  document.getElementById('boton-ia').addEventListener('click', async () => {
    pintarOpinion({ pensando: true });
    try {
      const r = await fetch(`/api/viaje/${viajeId}/opinar`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`Error ${r.status}`);
      sondearOpinion();
    } catch (err) {
      console.error('[lienzo] no se pudo pedir la opinión:', err);
      pintarOpinion({ error: err.message });
    }
  });

  let sondeando = false;
  async function sondearOpinion() {
    if (sondeando) return;
    sondeando = true;

    const paso = async () => {
      try {
        const r = await fetch(`/api/viaje/${viajeId}/opinion`, { headers: { Accept: 'application/json' } });
        const datos = await r.json();
        if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

        if (datos.pensando) {
          setTimeout(paso, 3000);
          return;
        }
        sondeando = false;
        pintarOpinion({ opinion: datos.opinion, error: datos.mensaje_error });
      } catch (err) {
        sondeando = false;
        console.error('[lienzo] no se pudo consultar la opinión:', err);
        pintarOpinion({ error: err.message });
      }
    };
    setTimeout(paso, 2000);
  }

  pintarOpinion(opinionInicial);
  if (opinionInicial.pensando) sondearOpinion();

  pintar();
})();
