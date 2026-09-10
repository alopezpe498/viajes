/**
 * public/js/antes-de-viajar.js
 * -----------------------------------------------------------------------------
 * LA FICHA PRÁCTICA DEL PAÍS, en "Mi ruta".
 *
 * Qué hace falta para entrar y qué hay que llevarse. Se mira mientras se
 * organiza el viaje —un visado se pide con semanas, una vacuna con más—, así
 * que el botón está siempre a la vista y no hay que descubrirlo.
 *
 * CÓMO SE CARGA, Y POR QUÉ ASÍ. El panel abre INMEDIATAMENTE con lo que haya
 * guardado y solo después pide lo que falte. Generar una ficha llama a la IA,
 * a Nager y a Exteriores, y eso son segundos: abrir un panel y quedarse
 * mirando una ruedecita antes de ver nada es la forma más rápida de que algo
 * deje de consultarse.
 *
 * Una pestaña por país, deducidas de las etapas en el servidor. Si el viaje
 * cruza a otro país aparece la segunda sola; si es a uno, ni se nota.
 */
(() => {
  const raiz = document.querySelector('[data-viaje]');
  const boton = document.getElementById('abrir-antes');
  const fondo = document.getElementById('antes-fondo');
  if (!raiz || !boton || !fondo) return;

  const viajeId = raiz.dataset.viaje;
  const zonaPaises = document.getElementById('antes-paises');
  const zonaCuerpo = document.getElementById('antes-cuerpo');
  const zonaRango = document.getElementById('antes-rango');

  /** Lo último que contestó el servidor. Se repinta desde aquí. */
  let datos = null;
  let paisAbierto = null;
  /** Países que se están generando ahora mismo, para no pedirlos dos veces. */
  const generando = new Set();
  /** Lo mismo para el bloque del tiempo, que va por su cuenta. */
  const pidiendoClima = new Set();
  /** Y los que ya se han pedido solos en esta apertura: una vez y no más. */
  const climaPedido = new Set();
  /** Los cruces de frontera se piden una vez por apertura, como el clima. */
  let pidiendoFronteras = false;
  let fronterasPedidas = false;

  const esc = (t) => {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  };

  // ===========================================================================
  // ABRIR Y CERRAR
  // ===========================================================================
  function abrir() {
    fondo.hidden = false;
    document.body.classList.add('con-antes');
    cargar();
  }

  function cerrar() {
    fondo.hidden = true;
    document.body.classList.remove('con-antes');
  }

  boton.addEventListener('click', abrir);

  fondo.addEventListener('click', (ev) => {
    // Tocar fuera cierra; tocar dentro, no.
    if (ev.target === fondo || ev.target.closest('[data-antes-cerrar]')) cerrar();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !fondo.hidden) {
      ev.preventDefault();
      cerrar();
    }
  });

  // ===========================================================================
  // YA LO HE REVISADO
  // ---------------------------------------------------------------------------
  // Marcarlo apaga el aviso de "Mi ruta" y lo pone verde, como un vuelo
  // elegido. Es reversible: se desmarca y vuelve el ámbar. Y el botón cambia
  // AQUÍ MISMO, sin recargar, porque si hay que salir y volver para verlo la
  // mitad de las veces se piensa que no ha funcionado.
  // ===========================================================================
  const check = document.getElementById('antes-revisado');
  const piePropio = document.getElementById('antes-revisado-pie');

  function pintarRevisado(revisadoEn) {
    const hecho = Boolean(revisadoEn);
    if (check) check.checked = hecho;

    boton.classList.toggle('antes-boton--hecho', hecho);
    boton.dataset.revisado = hecho ? '1' : '';

    const icono = boton.querySelector('.antes-boton__icono');
    if (icono) icono.className = `ti ${hecho ? 'ti-check' : 'ti-alert-triangle'} antes-boton__icono`;

    const pie = boton.querySelector('.antes-boton__pie');
    if (pie) {
      pie.textContent = hecho
        ? 'Revisado. Puedes volver a mirarlo cuando quieras.'
        : 'Papeles, vacunas, dinero y festivos de cada país';
    }

    if (piePropio) {
      piePropio.textContent = hecho
        ? `El aviso de «Mi ruta» queda en verde.`
        : 'Mientras no lo marques, «Mi ruta» seguirá avisando.';
    }
  }

  check?.addEventListener('change', async () => {
    const quiero = check.checked;
    check.disabled = true;
    try {
      const r = await fetch(`/api/viaje/${viajeId}/antes-de-viajar/revisado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ revisado: quiero }),
      });
      if (!r.ok) throw new Error(`Error ${r.status}`);
      pintarRevisado((await r.json()).revisadoEn);
    } catch (err) {
      console.error('[antes] no se pudo guardar lo de revisado:', err);
      check.checked = !quiero;   // se deshace lo que no se guardó
    } finally {
      check.disabled = false;
    }
  });

  // Al cargar, el pie del check dice lo que toca.
  pintarRevisado(boton.dataset.revisado);

  // ===========================================================================
  // TRAER Y PINTAR
  // ===========================================================================
  async function cargar() {
    pintarCargando();
    try {
      const r = await fetch(`/api/viaje/${viajeId}/antes-de-viajar`, {
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
      datos = await r.json();
    } catch (err) {
      console.error('[antes] no se pudo consultar:', err);
      zonaCuerpo.innerHTML =
        `<p class="antes__vacio">No se pudo consultar la información: ${esc(err.message)}</p>`;
      return;
    }

    if (!datos.paises.length) {
      zonaPaises.innerHTML = '';
      zonaCuerpo.innerHTML =
        '<p class="antes__vacio">Todavía no hay paradas confirmadas, así que no sé por qué ' +
        'países pasa el viaje. Añade alguna a la ruta y vuelve.</p>';
      return;
    }

    zonaRango.textContent = datos.rango ?? 'Sin fechas todavía';
    paisAbierto = paisAbierto && datos.paises.some((p) => p.norm === paisAbierto)
      ? paisAbierto
      : datos.paises[0].norm;

    pintar();

    // Y ahora, lo que falte. Va uno a uno y sin bloquear: cada país que llega
    // se pinta en cuanto está.
    for (const p of datos.paises) {
      if (!p.ficha) generar(p, { silencioso: true });

      // EL TIEMPO DE AHORA SE CARGA SOLO LA PRIMERA VEZ Y NUNCA MÁS.
      //
      // Un bloque vacío con un botón para llenarlo es un bloque que nadie
      // pulsa. Pero tampoco puede refrescarse en cada apertura: son datos de
      // hoy, no de este segundo, y la hora de actualización está a la vista
      // precisamente para que uno decida si le vale o pulsa «Actualizar».
      if (p.clima?.ahora?.vacio && !climaPedido.has(p.norm)) {
        climaPedido.add(p.norm);
        refrescarClima(p, { silencioso: true });
      }
    }

    // Y los cruces de frontera, la primera vez que se abre una ficha de un
    // viaje que cruza alguna. Mismo criterio que el clima: un bloque vacio con
    // un boton es un bloque que nadie pulsa, pero tampoco se rehace en cada
    // apertura porque no cambia de un dia para otro.
    if (datos.fronteras?.hay && !datos.fronteras.datos && !fronterasPedidas) {
      fronterasPedidas = true;
      pedirFronteras(true);
    }
  }

  function pintarCargando() {
    zonaPaises.innerHTML = '';
    zonaCuerpo.innerHTML =
      '<p class="antes__cargando"><span class="rueda" aria-hidden="true"></span> Un momento…</p>';
  }

  function pintar() {
    // --- Las pestañas de país ---------------------------------------------
    zonaPaises.innerHTML = datos.paises
      .map((p) => {
        const aviso = p.ficha?.convieneActualizar ? '<span class="antes-pais__punto"></span>' : '';
        return (
          `<button class="antes-pais ${p.norm === paisAbierto ? 'antes-pais--activo' : ''}" ` +
          `type="button" role="tab" data-pais="${esc(p.norm)}" ` +
          `aria-selected="${p.norm === paisAbierto}">${esc(p.pais)}${aviso}</button>`
        );
      })
      .join('');

    // Con un solo país la barra de pestañas no aporta nada: se esconde.
    zonaPaises.hidden = datos.paises.length < 2;

    const actual = datos.paises.find((p) => p.norm === paisAbierto);
    // LAS FRONTERAS VAN ARRIBA Y FUERA DE LAS PESTAÑAS. Un cruce no es de
    // ninguno de los dos países: es del viaje, y meterlo dentro de una pestaña
    // obligaría a elegir en cuál, que es una pregunta sin respuesta.
    zonaCuerpo.innerHTML = bloqueFronteras() + (actual ? cuerpoDePais(actual) : '');
  }

  zonaPaises.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pais]');
    if (!b) return;
    paisAbierto = b.dataset.pais;
    pintar();
  });

  zonaCuerpo.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-fronteras]')) {
      pedirFronteras();
      return;
    }

    const clima = ev.target.closest('[data-clima]');
    if (clima) {
      const p = datos.paises.find((x) => x.norm === clima.dataset.clima);
      if (p) refrescarClima(p);
      return;
    }

    const b = ev.target.closest('[data-actualizar]');
    if (!b) return;
    const p = datos.paises.find((x) => x.norm === b.dataset.actualizar);
    if (p) generar(p);
  });

  // ===========================================================================
  // EL CUERPO DE UN PAÍS
  // ===========================================================================
  function cuerpoDePais(p) {
    if (generando.has(p.norm)) {
      return (
        '<p class="antes__cargando"><span class="rueda" aria-hidden="true"></span> ' +
        `Preparando la ficha de ${esc(p.pais)}. Tarda unos segundos: se consultan ` +
        'los papeles, los festivos y las recomendaciones de Exteriores.</p>'
      );
    }

    const f = p.ficha;
    if (!f) {
      return (
        `<p class="antes__vacio">Todavía no hay ficha de ${esc(p.pais)}.</p>` +
        `<button class="boton boton--primario" type="button" data-actualizar="${esc(p.norm)}">` +
        '<i class="ti ti-sparkles" aria-hidden="true"></i> Prepararla</button>'
      );
    }

    return [
      f.convieneActualizar ? bandaDeCaducidad(f) : '',
      bloquePapeles(f),
      bloqueDinero(f),
      bloqueClimaTipico(p),
      bloqueAhora(p),
      (f.problemas ?? []).length ? bloqueProblemas(f) : '',
      pieDeFicha(p, f),
    ].join('');
  }

  // ===========================================================================
  // EL TIEMPO, EN DOS BLOQUES QUE NO SON LA MISMA PREGUNTA
  // ---------------------------------------------------------------------------
  // Arriba, qué SUELE hacer en tus fechas: es lo que decide la maleta y se
  // calcula una vez, con la ficha. Abajo, qué está pasando AHORA mismo allí,
  // que no tiene nada que ver con cuándo vayas y por eso lleva su propia hora y
  // su propio botón. Separarlos no es estética: mezclados, una previsión de
  // esta semana se lee como el tiempo que va a hacer en el viaje.
  // ===========================================================================
  function bloqueClimaTipico(p) {
    const lineas = p.clima?.tipico ?? [];
    if (!lineas.length) return '';

    const filas = lineas
      .map(
        (c) =>
          '<li class="clima-linea">' +
          `<span class="clima-linea__ciudad">${esc(c.ciudad)}</span>` +
          `<span class="clima-linea__cuando">${esc(c.epoca ?? '')}</span>` +
          `<span class="clima-linea__grados">${esc(c.rango ?? `${c.minMedia}-${c.maxMedia}°`)}</span>` +
          `<span class="clima-linea__lluvia">${esc(c.lluviaTexto)}</span>` +
          '</li>'
      )
      .join('');

    const contraste = p.clima?.contraste
      ? `<p class="clima-contraste"><i class="ti ti-arrows-diff" aria-hidden="true"></i> ${esc(p.clima.contraste)}</p>`
      : '';

    const anos = lineas[0]?.anos;

    return (
      '<section class="antes-bloque">' +
      '<h3 class="antes-bloque__titulo"><i class="ti ti-cloud-filled" aria-hidden="true"></i> ' +
      'Clima en tus fechas</h3>' +
      `<ul class="clima-lineas">${filas}</ul>` +
      contraste +
      '<p class="antes-dato__nota">Lo que hizo de verdad en esas mismas fechas ' +
      (anos ? `en los últimos ${esc(String(anos))} años` : 'en años anteriores') +
      ', medido por Open-Meteo. No es una predicción: es lo normal allí por esas fechas.</p>' +
      '</section>'
    );
  }

  function bloqueAhora(p) {
    const a = p.clima?.ahora;
    const pidiendo = pidiendoClima.has(p.norm);

    const cabecera =
      '<h3 class="antes-bloque__titulo"><i class="ti ti-sun" aria-hidden="true"></i> ' +
      'Ahora en el destino ' +
      '<span class="clima-sello">esta semana, no tu viaje</span></h3>';

    const boton =
      `<button class="antes-pie__actualizar" type="button" data-clima="${esc(p.norm)}"` +
      (pidiendo ? ' disabled' : '') +
      '><i class="ti ti-refresh" aria-hidden="true"></i> ' +
      // «Actualizar» a secas, no: justo debajo está el de la ficha entera y los
      // dos botones se leen igual. Este solo rehace el tiempo, y lo dice.
      (pidiendo ? 'Consultando…' : 'Actualizar el tiempo') +
      '</button>';

    if (!a || a.vacio) {
      return (
        '<section class="antes-bloque">' + cabecera +
        '<p class="antes-dato__nota">' +
        (pidiendo
          ? 'Preguntando a Open-Meteo qué tiempo hace allí…'
          : 'Todavía no se ha consultado el tiempo de estos días.') +
        '</p>' +
        `<footer class="antes-pie"><span class="antes-pie__fecha"></span>${boton}</footer>` +
        '</section>'
      );
    }

    const avisos = (a.avisos ?? []).length
      ? '<ul class="clima-avisos">' +
        a.avisos
          .map(
            (x) =>
              `<li class="clima-aviso clima-aviso--${esc(x.tipo)}">` +
              `<i class="ti ${esc(x.icono)}" aria-hidden="true"></i> ${esc(x.texto)}</li>`
          )
          .join('') +
        '</ul>'
      : '';

    const ciudades = (a.ciudades ?? [])
      .map(
        (c) =>
          '<div class="clima-ciudad">' +
          `<h4 class="clima-ciudad__nombre">${esc(c.ciudad)}</h4>` +
          '<ol class="clima-dias">' +
          (c.dias ?? []).map(diaDePrevision).join('') +
          '</ol></div>'
      )
      .join('');

    return (
      '<section class="antes-bloque">' + cabecera +
      '<p class="antes-dato__nota">Qué está pasando allí estos días, tengas el viaje ' +
      'la semana que viene o dentro de cinco meses.</p>' +
      avisos +
      `<div class="clima-ciudades">${ciudades}</div>` +
      '<footer class="antes-pie">' +
      `<span class="antes-pie__fecha">Actualizado el ${esc(a.actualizadoTexto ?? '—')}</span>` +
      boton +
      '</footer></section>'
    );
  }

  /** Un día de la tira: el día, el icono, los grados y la lluvia si la hay. */
  function diaDePrevision(d) {
    const lluvia =
      d.probLluvia != null && d.probLluvia >= 20
        ? `<span class="clima-dia__lluvia">${esc(String(Math.round(d.probLluvia)))}%</span>`
        : '<span class="clima-dia__lluvia"></span>';

    return (
      `<li class="clima-dia" title="${esc(d.cielo)}">` +
      `<span class="clima-dia__nombre">${esc(d.dia)} ${esc(String(d.numero))}</span>` +
      `<i class="ti ${esc(d.icono)} clima-dia__icono" aria-hidden="true"></i>` +
      '<span class="clima-dia__grados">' +
      `<strong>${d.max == null ? '—' : esc(String(Math.round(d.max)))}°</strong>` +
      `<span>${d.min == null ? '' : esc(String(Math.round(d.min))) + '°'}</span>` +
      '</span>' +
      lluvia +
      '</li>'
    );
  }

  // ===========================================================================
  // ACTUALIZAR SOLO EL TIEMPO DE AHORA
  // ---------------------------------------------------------------------------
  // Su propia ruta y su propia petición: esto no vuelve a preguntar por visados
  // ni por festivos. Lo que había en la ficha se queda intacto.
  // ===========================================================================
  async function refrescarClima(p, { silencioso = false } = {}) {
    if (pidiendoClima.has(p.norm)) return;
    pidiendoClima.add(p.norm);

    // SIN PERDER EL SITIO. `pintar` rehace el cuerpo entero por innerHTML, y el
    // bloque del tiempo está abajo del todo: sin esto, pulsar «Actualizar» te
    // devolvía al principio de la ficha y había que volver a bajar para ver el
    // resultado de lo que acababas de pulsar.
    const dondeIba = zonaCuerpo.scrollTop;
    const repintar = () => {
      pintar();
      zonaCuerpo.scrollTop = dondeIba;
    };

    if (!silencioso || p.norm === paisAbierto) repintar();

    try {
      const r = await fetch(`/api/viaje/${viajeId}/clima`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ pais: p.pais }),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cuerpo.error || `Error ${r.status}`);
      p.clima = cuerpo.clima;
    } catch (err) {
      console.error(`[antes] no se pudo consultar el tiempo de ${p.pais}:`, err);
    } finally {
      pidiendoClima.delete(p.norm);
      repintar();
    }
  }

  const bandaDeCaducidad = (f) =>
    '<p class="antes-caduca">' +
    '<i class="ti ti-alert-triangle" aria-hidden="true"></i> ' +
    `Esto se preparó hace ${f.diasDesdeGeneracion} días y el viaje se acerca. ` +
    'Conviene actualizarlo: los requisitos de entrada cambian.</p>';

  /** Un apartado con su icono, su título y su contenido. Vacío, no se pinta. */
  function apartado(icono, titulo, contenido) {
    if (!contenido) return '';
    return (
      '<div class="antes-dato">' +
      `<h4 class="antes-dato__titulo"><i class="ti ${icono}" aria-hidden="true"></i> ${esc(titulo)}</h4>` +
      `<div class="antes-dato__cuerpo">${contenido}</div>` +
      '</div>'
    );
  }

  const parrafo = (t) => (t ? `<p>${esc(t)}</p>` : '');
  const lista = (xs) =>
    xs && xs.length ? `<ul class="antes-lista">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';

  /** Una pastilla de sí/no, que es lo primero que se busca al mirar esto. */
  const marca = (siNo, textoSi, textoNo) =>
    `<span class="antes-marca ${siNo ? 'antes-marca--si' : 'antes-marca--no'}">` +
    `<i class="ti ${siNo ? 'ti-alert-circle' : 'ti-check'}" aria-hidden="true"></i> ` +
    `${esc(siNo ? textoSi : textoNo)}</span>`;

  function bloquePapeles(f) {
    const pap = f.papeles ?? {};
    const salud = f.salud ?? {};

    const documento =
      parrafo(pap.documento) +
      (pap.vigenciaMinima ? `<p class="antes-dato__nota">Vigencia mínima: ${esc(pap.vigenciaMinima)}</p>` : '');

    const visado = pap.visado
      ? marca(pap.visado.haceFalta, 'Hace falta visado', 'No hace falta visado') +
        parrafo(pap.visado.texto) +
        (pap.visado.tramite ? `<p class="antes-dato__nota">${esc(pap.visado.tramite)}</p>` : '')
      : '';

    const seguro = pap.seguro
      ? marca(pap.seguro.obligatorio, 'Seguro obligatorio', 'Seguro no obligatorio') +
        parrafo(pap.seguro.texto)
      : '';

    const vacunas =
      lista(salud.vacunasObligatorias?.length ? salud.vacunasObligatorias : null) ||
      lista(salud.vacunasRecomendadas) ||
      salud.nota
        ? (salud.vacunasObligatorias?.length
            ? `<p class="antes-dato__nota">Obligatorias:</p>${lista(salud.vacunasObligatorias)}`
            : '<p class="antes-dato__nota">Ninguna obligatoria.</p>') +
          (salud.vacunasRecomendadas?.length
            ? `<p class="antes-dato__nota">Recomendadas:</p>${lista(salud.vacunasRecomendadas)}`
            : '') +
          parrafo(salud.nota)
        : '';

    const dentro = [
      apartado('ti-id', 'Documento', documento),
      apartado('ti-stamp', 'Visado', visado),
      apartado('ti-vaccine', 'Vacunas y salud', vacunas),
      apartado('ti-shield-check', 'Seguro de viaje', seguro),
    ].join('');

    if (!dentro) return '';
    return (
      '<section class="antes-bloque">' +
      '<h3 class="antes-bloque__titulo"><i class="ti ti-file-text" aria-hidden="true"></i> Papeles y salud</h3>' +
      `<div class="antes-bloque__rejilla">${dentro}</div></section>`
    );
  }

  function bloqueDinero(f) {
    const d = f.dinero ?? {};

    const moneda =
      parrafo(d.moneda) +
      (d.esEuro === true ? '<p class="antes-dato__nota">Se paga en euros, como en casa.</p>' : '') +
      (d.esEuro === false ? '<p class="antes-dato__nota">No es euro: habrá que cambiar.</p>' : '');

    const cambio = parrafo(d.dondeCambiar) + lista(d.consejos);

    const festivos = (f.festivos ?? []).length
      ? '<ul class="antes-festivos">' +
        f.festivos
          .map(
            (x) =>
              `<li><span class="antes-festivos__dia">${esc(x.diaMes)}</span> ${esc(x.nombre)}</li>`
          )
          .join('') +
        '</ul>' +
        '<p class="antes-dato__nota">Museos y comercios pueden cerrar, y el transporte ' +
        'suele ir en horario reducido.</p>'
      : f.fuentes?.festivos
        ? '<p class="antes-dato__nota">Ningún festivo nacional durante el viaje.</p>'
        : '';

    const ext = f.exteriores
      ? `<span class="antes-sev antes-sev--${esc(f.exteriores.severidad)}">` +
        `${esc(etiquetaSeveridad(f.exteriores.severidad))}</span>` +
        parrafo(primerasFrases(f.exteriores.texto)) +
        (f.exteriores.url
          ? `<p><a class="antes-enlace" href="${esc(f.exteriores.url)}" target="_blank" rel="noopener">` +
            'Leer la recomendación completa <i class="ti ti-external-link" aria-hidden="true"></i></a></p>'
          : '')
      : '';

    const dentro = [
      apartado('ti-cash', 'Moneda', moneda),
      apartado('ti-arrows-exchange', 'Dónde y cuándo cambiar', cambio),
      apartado('ti-calendar-event', 'Festivos durante el viaje', festivos),
      apartado('ti-shield-exclamation', 'Recomendaciones de Exteriores', ext),
    ].join('');

    if (!dentro) return '';
    return (
      '<section class="antes-bloque">' +
      '<h3 class="antes-bloque__titulo"><i class="ti ti-wallet" aria-hidden="true"></i> Dinero y calendario</h3>' +
      `<div class="antes-bloque__rejilla">${dentro}</div></section>`
    );
  }

  /**
   * Las primeras frases, que es lo que cabe en una tarjeta.
   *
   * La sección de Exteriores viene entera: la de Polonia son tres mil quinientos
   * caracteres y se comía el panel de arriba abajo, dejando los papeles y el
   * dinero fuera de la pantalla. Aquí se enseña la entradilla y el enlace de
   * debajo lleva al texto completo, que además se guarda entero y sale sin
   * recortar en el dosier —ahí sí hay sitio, y es lo que se lee sin conexión—.
   */
  function primerasFrases(texto, cuantas = 3, tope = 420) {
    const t = String(texto ?? '').trim();
    if (t.length <= tope) return t;

    const frases = t.split(/(?<=[.!?])\s+/);
    let salida = '';
    for (const f of frases) {
      if (salida && (salida.length + f.length > tope || salida.split(/(?<=[.!?])\s+/).length >= cuantas)) break;
      salida += (salida ? ' ' : '') + f;
    }
    return (salida || t.slice(0, tope)).trim() + ' […]';
  }

  const etiquetaSeveridad = (s) =>
    s === 'alerta' ? 'Se desaconseja viajar' : s === 'precaucion' ? 'Extremar precauciones' : 'Sin aviso especial';

  /** Lo que no se pudo consultar, dicho y no escondido. */
  const bloqueProblemas = (f) =>
    '<p class="antes-problemas"><i class="ti ti-info-circle" aria-hidden="true"></i> ' +
    f.problemas.map((x) => esc(x)).join(' ') +
    '</p>';

  const pieDeFicha = (p, f) =>
    '<footer class="antes-pie">' +
    `<span class="antes-pie__fecha">Preparado el ${esc(f.generadoEnLargo ?? '—')}</span>` +
    `<button class="antes-pie__actualizar" type="button" data-actualizar="${esc(p.norm)}">` +
    '<i class="ti ti-refresh" aria-hidden="true"></i> Actualizar</button>' +
    '</footer>';


  // ===========================================================================
  // LOS CRUCES DE FRONTERA
  // ---------------------------------------------------------------------------
  // Una sola vez y fuera de las pestañas: un cruce no es de ninguno de los dos
  // países, es del viaje. Y depende del ORDEN de las paradas, así que solo
  // aparece cuando la ruta ya está confirmada.
  //
  // Lo que de verdad justifica este bloque es la DOBLE ENTRADA: volar de vuelta
  // desde un país por el que ya se pasó exige poder entrar en él dos veces, y
  // eso no se ve mirando la lista de países ni la ficha de ninguno de ellos. Se
  // ve mirando la secuencia, que es lo que se pinta arriba del todo.
  // ===========================================================================
  function bloqueFronteras() {
    const f = datos.fronteras;
    if (!f?.hay) return '';

    const ruta =
      '<p class="frontera-ruta">' +
      f.secuencia.map((t) => `<span class="frontera-ruta__pais">${esc(t.pais)}</span>`).join(
        '<i class="ti ti-arrow-right" aria-hidden="true"></i>'
      ) +
      '</p>';

    const boton =
      `<button class="antes-pie__actualizar" type="button" data-fronteras ${pidiendoFronteras ? 'disabled' : ''}>` +
      '<i class="ti ti-refresh" aria-hidden="true"></i> ' +
      (pidiendoFronteras ? 'Consultando…' : f.datos ? 'Actualizar' : 'Consultar') +
      '</button>';

    const cruces = (f.datos?.cruces ?? []).length
      ? '<ul class="fronteras">' +
        f.datos.cruces
          .map(
            (c) =>
              `<li class="frontera ${c.dobleEntrada ? 'frontera--doble' : ''}">` +
              '<p class="frontera__titulo">' +
              `<i class="ti ${ICONO_CRUCE[c.tipo] ?? 'ti-border-all'}" aria-hidden="true"></i> ` +
              `${esc(c.desde)} → ${esc(c.hasta)}` +
              (c.entre ? `<span class="frontera__entre">${esc(c.entre)}</span>` : '') +
              '</p>' +
              (c.dobleEntrada
                ? '<p class="frontera__doble"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ' +
                  'Entras dos veces en este país: comprueba que tu permiso lo admite.</p>'
                : '') +
              (c.quePide ? `<p class="frontera__pide">${esc(c.quePide)}</p>` : '') +
              '</li>'
          )
          .join('') +
        '</ul>'
      : `<p class="antes-dato__nota">${
          pidiendoFronteras
            ? 'Mirando qué pide cada paso de frontera…'
            : 'Todavía no se han consultado los pasos de frontera de esta ruta.'
        }</p>`;

    return (
      '<section class="antes-bloque">' +
      '<h3 class="antes-bloque__titulo"><i class="ti ti-border-all" aria-hidden="true"></i> ' +
      'Cruces de frontera</h3>' +
      ruta +
      cruces +
      (f.datos?.nota ? `<p class="antes-dato__nota">${esc(f.datos.nota)}</p>` : '') +
      '<footer class="antes-pie">' +
      `<span class="antes-pie__fecha">${
        f.datos?.calculadoEn ? `Consultado el ${esc(f.datos.calculadoEn.slice(0, 10))}` : ''
      }</span>` +
      boton +
      '</footer></section>'
    );
  }

  const ICONO_CRUCE = {
    terrestre: 'ti-car',
    aereo: 'ti-plane',
    maritimo: 'ti-ship',
  };

  async function pedirFronteras(silencioso = false) {
    if (pidiendoFronteras) return;
    pidiendoFronteras = true;
    const dondeIba = zonaCuerpo.scrollTop;
    if (!silencioso) pintar();

    try {
      const r = await fetch(`/api/viaje/${viajeId}/fronteras`, { method: 'POST' });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cuerpo.error || `Error ${r.status}`);
      if (datos.fronteras) datos.fronteras.datos = cuerpo.fronteras;
    } catch (err) {
      console.error('[antes] no se pudieron consultar las fronteras:', err);
    } finally {
      pidiendoFronteras = false;
      pintar();
      zonaCuerpo.scrollTop = dondeIba;
    }
  }

  // ===========================================================================
  // GENERAR UN PAÍS
  // ===========================================================================
  async function generar(p, { silencioso = false } = {}) {
    if (generando.has(p.norm)) return;
    generando.add(p.norm);
    if (!silencioso || p.norm === paisAbierto) pintar();

    try {
      const r = await fetch(`/api/viaje/${viajeId}/antes-de-viajar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ pais: p.pais, codigoPais: p.codigoPais }),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cuerpo.error || `Error ${r.status}`);
      p.ficha = cuerpo.ficha;
      // La misma respuesta trae el clima típico recién calculado.
      if (cuerpo.clima) p.clima = cuerpo.clima;
    } catch (err) {
      console.error(`[antes] no se pudo preparar ${p.pais}:`, err);
      p.error = err.message;
    } finally {
      generando.delete(p.norm);
      pintar();
    }
  }
})();
