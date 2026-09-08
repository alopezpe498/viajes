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
    zonaCuerpo.innerHTML = actual ? cuerpoDePais(actual) : '';
  }

  zonaPaises.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pais]');
    if (!b) return;
    paisAbierto = b.dataset.pais;
    pintar();
  });

  zonaCuerpo.addEventListener('click', (ev) => {
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
      (f.problemas ?? []).length ? bloqueProblemas(f) : '',
      pieDeFicha(p, f),
    ].join('');
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
    } catch (err) {
      console.error(`[antes] no se pudo preparar ${p.pais}:`, err);
      p.error = err.message;
    } finally {
      generando.delete(p.norm);
      pintar();
    }
  }
})();
