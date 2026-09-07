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
    traslado: 'ti-arrow-right',
  };

  /* Un traslado enseña SU medio: un taxi y un metro no son lo mismo de un
     vistazo, y en una tarjeta tan fina el icono es medio mensaje. */
  const ICONO_MEDIO = {
    // Los tres de un traslado consultado.
    andando: 'ti-walk',
    coche: 'ti-car',
    publico: 'ti-bus',
    // Y los de una ficha de "Moverse".
    metro: 'ti-train-filled',
    bus: 'ti-bus',
    taxi: 'ti-car',
    app: 'ti-device-mobile',
    tarjeta: 'ti-credit-card',
    especial: 'ti-sparkles',
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
        ${meta({ ...m, duracionCatalogo: m.duracion })}
      </article>`;
  }

  /**
   * La línea de debajo: lo que NO está ya en el reloj.
   *
   * La hora y la duración tecleadas viven en sus casillas, así que repetirlas
   * aquí sería decir dos veces lo mismo. Queda la duración que trae el catálogo
   * —"2 horas" de una excursión, como orientación— y el precio.
   */
  function meta(x) {
    const trozos = [];
    // Solo la del catálogo, y solo si no hay una tecleada que la sustituya.
    if (!x.duracionMin && x.duracionCatalogo) trozos.push(esc(x.duracionCatalogo));
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

        ${cosas
          .map(
            (c, i) =>
              hueco(d.n, f.clave, i) + tarjetaColocada(c, enConflicto.has(c.id))
          )
          .join('')}
        ${hueco(d.n, f.clave, cosas.length)}
      </div>`;
  }

  /**
   * El hueco entre dos tarjetas: una raya finísima con un "+" que solo se ve al
   * pasar por encima.
   *
   * TIENE QUE SER CASI INVISIBLE. Hay uno entre cada par de tarjetas y en los
   * dos bordes de cada franja, o sea cinco o seis por franja: si se vieran
   * todos, el día parecería un formulario. Se insinúa al acercar el ratón, y en
   * el móvil basta con que la zona sea tocable.
   *
   * De momento ofrece una sola cosa —calcular el traslado entre lo de antes y
   * lo de después—, pero el menú ya está para lo que venga.
   */
  function hueco(dia, franja, indice) {
    return `
      <div class="hueco" data-hueco="${dia}:${franja}:${indice}">
        <button class="hueco__mas" type="button" aria-label="Añadir algo aquí">
          <i class="ti ti-plus" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  function tarjetaColocada(c, conflicto) {
    return `
      <article class="item item--${c.tipo} ${conflicto ? 'item--conflicto' : ''}"
               draggable="true" data-fila="${c.id}">
        <div class="item__fila">
          <i class="ti ${(c.tipo === 'traslado' && ICONO_MEDIO[c.medio]) || ICONO_TIPO[c.tipo] || 'ti-point'}" aria-hidden="true"></i>
          <span class="item__nombre">${esc(c.nombre)}</span>
          ${flechas(c)}
          <button class="item__quitar" type="button" data-quitar="${c.id}"
                  title="${c.manual ? 'Borrar' : 'Devolver a la mochila'}"
                  aria-label="${c.manual ? 'Borrar' : 'Devolver a la mochila'}">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>
        ${meta(c)}
        ${reloj(c)}
      </article>`;
  }

  /**
   * Las flechas de subir y bajar.
   *
   * SOLO EN LAS QUE NO TIENEN HORA. Las que la tienen ya están ordenadas por
   * ella: empujarlas no cambiaría nada y el botón sería una promesa falsa.
   *
   * Existen porque hasta ahora una tarjeta nueva solo podía caer al final de su
   * franja: para meter una comida entre dos visitas había que sacarlo todo y
   * volver a ponerlo en orden.
   */
  function flechas(c) {
    if (c.hora) return '';
    return `
      <span class="item__flechas">
        <button class="item__flecha" type="button" data-subir="${c.id}"
                title="Subir" aria-label="Subir">
          <i class="ti ti-chevron-up" aria-hidden="true"></i>
        </button>
        <button class="item__flecha" type="button" data-bajar="${c.id}"
                title="Bajar" aria-label="Bajar">
          <i class="ti ti-chevron-down" aria-hidden="true"></i>
        </button>
      </span>`;
  }

  /**
   * La hora y la duración, en CUALQUIER tarjeta.
   *
   * Antes solo las escritas a mano —y luego traslados y comidas— podían llevar
   * hora. No tenía sentido: a las diez de la mañana en el Prado se llega a una
   * hora concreta igual que a una cena, y sin poder apuntarla el lienzo no
   * termina de ser un plan.
   *
   * LA HORA ES DEL PLAN, NO DE LA FICHA. La misma catedral puede ir a las diez
   * un día y a las seis otro; eso no se guarda en el catálogo, se guarda en la
   * tarjeta.
   *
   * NO SE PROPONE NINGUNA HORA. Ni la de apertura, ni una deducida de la
   * anterior más su duración. El campo nace vacío y lo rellena quien quiera:
   * una hora sugerida que nadie ha pedido se acaba dando por buena.
   *
   * Y va PLEGADO mientras no haya nada. Con cinco tarjetas en un día, diez
   * casillas vacías convierten la columna en un formulario; así solo se ve un
   * relojito, y se abre al tocarlo.
   */
  function reloj(c) {
    const tieneAlgo = Boolean(c.hora || c.duracionMin);
    return `
      <div class="item__reloj ${tieneAlgo ? '' : 'item__reloj--plegado'}">
        <button class="item__reloj-abrir" type="button" data-abrir-reloj="${c.id}"
                title="Poner hora o duración" aria-label="Poner hora o duración">
          <i class="ti ti-clock-plus" aria-hidden="true"></i>
        </button>
        <input type="time" value="${esc(c.hora)}" data-hora="${c.id}"
               aria-label="Hora de inicio" title="Hora de inicio">
        <input type="number" min="1" max="1440" step="5" placeholder="min"
               value="${c.duracionMin ?? ''}" data-duracion="${c.id}"
               aria-label="Duración en minutos" title="Duración en minutos">
        <span>${c.duracionMin >= 60 ? esc(c.duracion) : 'min'}</span>
      </div>`;
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
      return { ok: true };
    } catch (err) {
      // Se avisa aquí —todas las llamadas quieren eso— pero además se DEVUELVE
      // el motivo. Sin esto, quien necesita reaccionar al fallo no se entera:
      // el menú del "+" se quedaba en "calculando…" para siempre mientras el
      // aviso flotante aparecía y se iba en otra esquina de la pantalla.
      console.error('[lienzo] no se pudo aplicar el cambio:', err);
      avisar(err.message);
      return { ok: false, error: err.message };
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

  // --- La hora y la duración de un traslado ---------------------------------
  // Se guardan al salir del campo, como las notas de la etapa: son dos casillas
  // que uno rellena y deja, no un formulario que se envía.
  // El relojito: despliega las casillas de esa tarjeta. No manda nada al
  // servidor, solo enseña lo que estaba plegado.
  pantalla.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-abrir-reloj]');
    if (!boton) return;
    const caja = boton.closest('.item__reloj');
    caja.classList.remove('item__reloj--plegado');
    caja.querySelector('[data-hora]')?.focus();
  });

  // --- Subir y bajar dentro de la franja ------------------------------------
  pantalla.addEventListener('click', (ev) => {
    const arriba = ev.target.closest('[data-subir]');
    const abajo = ev.target.closest('[data-bajar]');
    if (!arriba && !abajo) return;

    const id = arriba?.dataset.subir ?? abajo.dataset.bajar;
    llamar(`/api/itinerario/${id}/mover-en-franja`, {
      method: 'POST',
      body: JSON.stringify(conEtapa({ direccion: arriba ? 'arriba' : 'abajo' })),
    });
  });

  pantalla.addEventListener('change', (ev) => {
    const hora = ev.target.closest('[data-hora]');
    const duracion = ev.target.closest('[data-duracion]');
    if (!hora && !duracion) return;

    const id = (hora ?? duracion).dataset.hora ?? duracion.dataset.duracion;
    llamar(`/api/itinerario/${id}/retocar`, {
      method: 'POST',
      body: JSON.stringify(
        conEtapa(hora ? { hora: hora.value || null } : { duracionMin: Number(duracion.value) || null })
      ),
    });
  });

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
  // EL "+" ENTRE TARJETAS
  // ---------------------------------------------------------------------------
  // Al tocarlo se pregunta al servidor QUÉ HAY a un lado y a otro, y con eso se
  // arma el menú. Los vecinos no siempre están en la misma franja —el de antes
  // puede ser la última tarjeta de la mañana— y en los bordes del día no hay
  // tarjeta: es el hotel, que es justo el traslado que uno quiere calcular.
  //
  // Esa lógica vive en el servidor a propósito: repetirla aquí sería tenerla
  // dos veces y que se separaran a la primera de cambio.
  // ===========================================================================
  pantalla.addEventListener('click', async (ev) => {
    const mas = ev.target.closest('.hueco__mas');
    if (!mas) return;

    const caja = mas.closest('.hueco');
    // Segundo toque en el mismo: se cierra. El botón es un interruptor.
    if (caja.querySelector('.hueco__menu')) return cerrarHuecos();

    cerrarHuecos();
    const [dia, franja, indice] = caja.dataset.hueco.split(':');

    caja.classList.add('hueco--abierto');
    const menu = document.createElement('div');
    menu.className = 'hueco__menu';
    menu.innerHTML = '<span class="hueco__cargando"><i class="ti ti-loader-2 girando"></i> mirando…</span>';
    caja.appendChild(menu);

    try {
      const r = await fetch(
        `/api/viaje/${viajeId}/hueco?dia=${dia}&franja=${franja}&indice=${indice}`,
        { headers: { Accept: 'application/json' } }
      );
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
      menu.innerHTML = pintarMenuHueco(datos);
      // El hueco entero se queda con el menú: el formulario de extremos y el
      // envío lo necesitan, y volver a pedirlo sería una llamada de más.
      menu.__hueco = datos;
      menu.dataset.dia = dia;
      menu.dataset.franja = franja;
      menu.dataset.indice = indice;
    } catch (err) {
      console.error('[lienzo] no se pudo mirar el hueco:', err);
      menu.innerHTML = `<span class="hueco__aviso">${esc(err.message)}</span>`;
    }
  });

  /**
   * El menú, que dice de dónde a dónde iría el traslado ANTES de calcularlo.
   *
   * Enseñar los dos extremos es lo que convierte un botón críptico en algo
   * obvio: "Traslado · Hotel → Museo del Prado" no necesita explicación.
   */
  function pintarMenuHueco(h) {
    if (!h.origen || !h.destino) {
      return `<span class="hueco__aviso">
                <i class="ti ti-info-circle"></i>
                ${h.hayHotel ? 'Aquí no hay nada que enlazar.'
                             : 'Elige alojamiento en esta parada para poder enlazar con él.'}
              </span>`;
    }

    // Si a un extremo le falta la dirección se dice CUÁL, y se ofrece ir a
    // ponérsela: es más útil que un "no se puede" a secas.
    const sinSitio = [h.origen, h.destino].find((x) => !x.situada);
    if (sinSitio) {
      // Se dice QUÉ ficha es la que no tiene dirección, con su nombre, y se dan
      // las dos salidas: ir a ponérsela, o elegir otro extremo que sí la tenga.
      // Quedarse solo con la primera obliga a salir del lienzo por un traslado
      // que a lo mejor ni siquiera era entre esas dos cosas.
      return `<span class="hueco__aviso">
                <i class="ti ti-map-pin-off"></i>
                Falta la dirección de <strong>${esc(sinSitio.nombre)}</strong>.
              </span>
              <a class="hueco__opcion" href="/etapa/${h.etapaId}#ver">
                <i class="ti ti-pencil"></i> <span>Ponérsela</span>
              </a>
              <button class="hueco__opcion hueco__opcion--fina" type="button" data-cambiar-extremos>
                <i class="ti ti-edit"></i> <span>O elegir otro sitio</span>
              </button>`;
    }

    return `
      <button class="hueco__opcion" type="button" data-hueco-traslado>
        <i class="ti ti-route" aria-hidden="true"></i>
        <span>
          <strong>Traslado</strong>
          <span class="hueco__extremos">${esc(h.origen.nombre)} → ${esc(h.destino.nombre)}</span>
        </span>
      </button>
      <button class="hueco__opcion hueco__opcion--fina" type="button" data-cambiar-extremos>
        <i class="ti ti-edit" aria-hidden="true"></i>
        <span>Cambiar de dónde a dónde</span>
      </button>
      <button class="hueco__opcion" type="button" data-hueco-comer>
        <i class="ti ti-tools-kitchen-2" aria-hidden="true"></i>
        <span>
          <strong>Comer</strong>
          <span class="hueco__extremos">Entre esos dos puntos</span>
        </span>
      </button>`;
  }

  /**
   * El formulario para elegir los extremos a mano.
   *
   * LO DEDUCIDO SIGUE SIENDO LA PROPUESTA: los dos campos vienen rellenos con
   * las tarjetas de al lado, que es lo que uno quiere nueve de cada diez veces.
   * Esto es para la décima: el traslado que sale del hotel aunque antes hubiera
   * un museo, o el que va al aeropuerto aunque no haya nada detrás.
   *
   * La lista es la MISMA del buscador de traslados de la etapa —el hotel, lo
   * apuntado, los restaurantes, el transporte urbano— y además admite escribir
   * una dirección cualquiera.
   */
  async function formularioDeExtremos(menu, h) {
    menu.innerHTML = '<span class="hueco__cargando"><i class="ti ti-loader-2 girando"></i> …</span>';

    let lugares = [];
    try {
      const r = await fetch(`/api/etapas/${h.etapaId}/lugares`, {
        headers: { Accept: 'application/json' },
      });
      if (r.ok) lugares = (await r.json()).lugares ?? [];
    } catch { /* sin lista: los dos campos siguen aceptando texto libre */ }

    // Se guarda para poder traducir lo tecleado a un elemento del viaje.
    menu.__lugares = lugares.filter((l) => l.situada);

    const opciones = menu.__lugares
      .map((l) => `<option value="${esc(l.nombre)}">${esc(l.etiqueta)}</option>`)
      .join('');

    menu.innerHTML = `
      <form class="hueco__form">
        <label>
          <span>Desde</span>
          <input name="origen" list="lugares-hueco" autocomplete="off"
                 value="${esc(h.origen?.nombre ?? '')}"
                 placeholder="Un sitio del viaje o una dirección">
        </label>
        <label>
          <span>Hasta</span>
          <input name="destino" list="lugares-hueco" autocomplete="off"
                 value="${esc(h.destino?.nombre ?? '')}"
                 placeholder="Un sitio del viaje o una dirección">
        </label>
        <datalist id="lugares-hueco">${opciones}</datalist>
        <div class="hueco__form-pie">
          <button class="boton boton--primario boton--pequeno" type="submit">Calcular</button>
          <button class="boton boton--secundario boton--pequeno" type="button" data-volver>Volver</button>
        </div>
      </form>`;
  }

  /** ¿Lo tecleado es un sitio del viaje, o texto suelto? */
  function comoExtremo(texto, lugares) {
    const t = String(texto ?? '').trim();
    if (!t) return null;
    const encaja = (lugares ?? []).find((l) => l.nombre.toLowerCase() === t.toLowerCase());
    return encaja ? { tipo: encaja.tipo, id: encaja.id, texto: encaja.nombre } : { texto: t };
  }

  function cerrarHuecos() {
    for (const c of pantalla.querySelectorAll('.hueco--abierto')) {
      c.classList.remove('hueco--abierto');
      c.querySelector('.hueco__menu')?.remove();
    }
  }

  /**
   * Un clic en cualquier otro sitio cierra el menú abierto.
   *
   * SE MIRA EL CAMINO DEL EVENTO, no `ev.target`, y esa diferencia es la que
   * tenía roto "Comer".
   *
   * Este manejador va en `document`, así que corre DESPUÉS de los de la
   * pantalla. Para cuando llega, el de "Comer" ya ha sustituido el contenido
   * del menú por el "buscando…", y con él el botón que se acababa de pulsar:
   * `ev.target` es un elemento que ya no está en el documento, su `closest()`
   * no encuentra ningún `.hueco`, y esto cerraba el menú entero. La petición
   * salía y contestaba treinta segundos después, pero no había dónde pintarla.
   * Desde fuera: pulsas "Comer" y no pasa nada.
   *
   * `composedPath()` se calcula al lanzar el evento y se queda guardado, así
   * que sigue diciendo por dónde pasó aunque el DOM haya cambiado debajo.
   */
  document.addEventListener('click', (ev) => {
    const dentroDeUnHueco = ev
      .composedPath()
      .some((n) => n instanceof Element && n.classList?.contains('hueco'));
    if (!dentroDeUnHueco) cerrarHuecos();
  });

  // --- Cambiar de dónde a dónde ---------------------------------------------
  pantalla.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-cambiar-extremos]');
    if (!boton) return;
    const menu = boton.closest('.hueco__menu');
    formularioDeExtremos(menu, menu.__hueco);
  });

  pantalla.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-volver]');
    if (!boton) return;
    const menu = boton.closest('.hueco__menu');
    menu.innerHTML = pintarMenuHueco(menu.__hueco);
  });

  pantalla.addEventListener('submit', (ev) => {
    const form = ev.target.closest('.hueco__form');
    if (!form) return;
    ev.preventDefault();

    const menu = form.closest('.hueco__menu');
    const origen = comoExtremo(form.origen.value, menu.__lugares);
    const destino = comoExtremo(form.destino.value, menu.__lugares);
    if (!origen || !destino) {
      avisar('Hay que decir desde dónde y hasta dónde.');
      return;
    }
    calcularYColocarTraslado(menu, { origen, destino });
  });

  /** Calcular y colocar, de un tirón. La consulta se guarda en la etapa. */
  pantalla.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-hueco-traslado]');
    if (!boton) return;
    // Sin extremos: manda lo deducido de las tarjetas de al lado.
    calcularYColocarTraslado(boton.closest('.hueco__menu'), {});
  });

  async function calcularYColocarTraslado(menu, extremos) {
    const donde = {
      dia: Number(menu.dataset.dia),
      franja: menu.dataset.franja,
      indice: Number(menu.dataset.indice),
    };
    const hueco = menu.__hueco;
    menu.innerHTML = '<span class="hueco__cargando"><i class="ti ti-loader-2 girando"></i> calculando…</span>';

    const r = await llamar(`/api/viaje/${viajeId}/hueco/traslado`, {
      method: 'POST',
      body: JSON.stringify(conEtapa({ ...donde, ...extremos })),
    });

    if (r.ok) return cerrarHuecos();

    // Al fallar se deja el motivo DENTRO del menú, no solo en el aviso
    // flotante, y con la puerta abierta para corregir los extremos sin tener
    // que volver a empezar.
    menu.innerHTML =
      `<span class="hueco__aviso"><i class="ti ti-alert-triangle"></i> ${esc(r.error)}</span>` +
      '<button class="hueco__opcion hueco__opcion--fina" type="button" data-cambiar-extremos>' +
      '<i class="ti ti-edit"></i> <span>Cambiar de dónde a dónde</span></button>';
    menu.__hueco = hueco;
  }

// --- Comer entre esos dos puntos ------------------------------------------
  // Se busca alrededor del punto medio con un radio proporcional a lo que
  // separa los extremos, y cada resultado dice SU DESVÍO. Sin el desvío, "de
  // paso" no significa nada: un sitio buenísimo a quince minutos del camino no
  // pilla de paso por muy céntrico que sea el punto medio.
  pantalla.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-hueco-comer]');
    if (!boton) return;

    const menu = boton.closest('.hueco__menu');
    const donde = { dia: Number(menu.dataset.dia), franja: menu.dataset.franja, indice: Number(menu.dataset.indice) };
    menu.innerHTML = '<span class="hueco__cargando"><i class="ti ti-loader-2 girando"></i> buscando dónde comer…</span>';

    try {
      const r = await fetch(`/api/viaje/${viajeId}/hueco/comer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(donde),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      menu.classList.add('hueco__menu--ancho');
      menu.innerHTML = pintarSitiosDeComer(datos);
      menu.dataset.dia = donde.dia;
      menu.dataset.franja = donde.franja;
      menu.dataset.indice = donde.indice;
    } catch (err) {
      console.error('[lienzo] no se pudo buscar dónde comer:', err);
      menu.innerHTML = `<span class="hueco__aviso"><i class="ti ti-alert-triangle"></i> ${esc(err.message)}</span>`;
    }
  });

  function pintarSitiosDeComer(datos) {
    if (!datos.sitios?.length) {
      return '<span class="hueco__aviso"><i class="ti ti-info-circle"></i> No se ha encontrado nada por ahí.</span>';
    }

    const cabecera =
      `<div class="hueco__titulo">Entre ${esc(datos.hueco.origen.nombre)} y ` +
      `${esc(datos.hueco.destino.nombre)}` +
      `<span class="hueco__fuente">${datos.fuente === 'places' ? 'Google' : 'IA'}</span></div>`;

    return (
      cabecera +
      datos.sitios
        .slice(0, 8)
        .map((s) => {
          const datosSitio = [
            s.cocina,
            s.precioSimbolo,
            s.valoracion != null ? `★ ${s.valoracion}` : null,
          ]
            .filter(Boolean)
            .join(' · ');

          // El desvío es lo que decide: cuánto hay de él a cada extremo.
          const desvio = s.desvio
            ? `<span class="hueco__desvio">${km(s.desvio.aOrigen)} y ${km(s.desvio.aDestino)} de los extremos</span>`
            : '<span class="hueco__desvio hueco__desvio--sin">sin situar: no se sabe el desvío</span>';

          return `
            <button class="hueco__sitio ${s.yaApuntado ? 'hueco__sitio--apuntado' : ''}"
                    type="button" data-elegir-comer="${s.id}">
              <span class="hueco__sitio-nombre">${esc(s.nombre)}
                ${s.yaApuntado
                  ? '<span class="hueco__apuntado"><i class="ti ti-bookmark-filled"></i> apuntado</span>'
                  : ''}</span>
              ${datosSitio ? `<span class="hueco__sitio-datos">${esc(datosSitio)}</span>` : ''}
              ${desvio}
            </button>`;
        })
        .join('')
    );
  }

  /** 0,4 -> "400 m"; 2,3 -> "2,3 km". Lo que uno diría. */
  function km(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(1).replace('.', ',')} km`;
  }

  pantalla.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-elegir-comer]');
    if (!boton) return;

    const menu = boton.closest('.hueco__menu');
    menu.innerHTML = '<span class="hueco__cargando"><i class="ti ti-loader-2 girando"></i> colocando…</span>';

    try {
      await llamar(`/api/viaje/${viajeId}/hueco/comer/colocar`, {
        method: 'POST',
        body: JSON.stringify(
          conEtapa({
            dia: Number(menu.dataset.dia),
            franja: menu.dataset.franja,
            indice: Number(menu.dataset.indice),
            fichaId: Number(boton.dataset.elegirComer),
          })
        ),
      });
    } finally {
      cerrarHuecos();
    }
  });

  // ===========================================================================
  // ARRASTRAR
  // ===========================================================================
  // Se engancha por delegación en el contenedor: las tarjetas se rehacen en
  // cada repintado, así que poner escuchas una por una sería volver a ponerlas
  // después de cada cambio.
  pantalla.addEventListener('dragstart', (ev) => {
    const item = ev.target.closest('.item');
    if (!item) return;

    // Las casillas de hora y duración van DENTRO de una tarjeta arrastrable, y
    // sin esto el navegador empieza a arrastrarla en cuanto pinchas en una y no
    // hay forma de escribir nada. Con las flechas de orden pasa lo mismo.
    if (ev.target.closest('.item__reloj, .item__flechas')) { ev.preventDefault(); return; }

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
